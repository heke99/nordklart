/**
 * GET /api/v1/companies/{companyId}/audit-logs
 *
 * Read the company's compliance audit trail (audit_log). Append-only rows
 * written by DB triggers (journal commits, period locks, reversals) and by
 * security-relevant application events (API-key lifecycle, webhook
 * auto-disable, BankID consents).
 */
import { z } from 'zod'
import { paginated } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
} from '@/lib/api/v1/pagination'

const AuditLogEntry = z.object({
  id: z.string().uuid(),
  action: z.string(),
  table_name: z.string().nullable(),
  record_id: z.string().nullable(),
  description: z.string().nullable(),
  created_at: z.string(),
})

registerEndpoint({
  operation: 'audit_logs.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/audit-logs',
  summary: 'List audit-log entries (granskningslogg).',
  description:
    'Returns the company\'s append-only audit trail in chronological order with cursor pagination. Filter by ?action (e.g. COMMIT, REVERSE, LOCK_PERIOD, SECURITY_EVENT) and ?table_name. Entries are immutable — the DB blocks updates.',
  useWhen:
    'External audit tooling, SIEM ingestion, or reviewing who committed/reversed/locked what and when.',
  doNotUseFor:
    'The ephemeral event feed (use /events). Full old/new state diffs are not exposed over the public API.',
  pitfalls: [
    'Rows are ordered oldest-first for stable cursor pagination — read to the end for the latest entries.',
    'action values include DB-trigger actions (INSERT/UPDATE/COMMIT/REVERSE/LOCK_PERIOD/CLOSE_PERIOD) and application SECURITY_EVENTs.',
  ],
  example: {
    response: {
      data: [
        {
          id: 'e1f2…',
          action: 'COMMIT',
          table_name: 'journal_entries',
          record_id: 'aa11…',
          description: 'Verifikation A-42 bokförd',
          created_at: '2026-06-02T10:00:00Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'audit:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: z.object({ audit_logs: z.array(AuditLogEntry) }) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'audit_logs.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const Filters = z.object({
      action: z.string().max(50).optional(),
      table_name: z.string().max(100).optional(),
    })
    const parsed = Filters.safeParse({
      action: url.searchParams.get('action') ?? undefined,
      table_name: url.searchParams.get('table_name') ?? undefined,
    })
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      })
    }

    let query = ctx.supabase
      .from('audit_log')
      .select('id, action, table_name, record_id, description, created_at')
      .eq('company_id', ctx.companyId!)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1)

    if (parsed.data.action) query = query.eq('action', parsed.data.action)
    if (parsed.data.table_name) query = query.eq('table_name', parsed.data.table_name)
    if (decoded) {
      query = query.or(
        `created_at.gt.${decoded.ts},and(created_at.eq.${decoded.ts},id.gt.${decoded.id})`,
      )
    }

    const { data, error } = await query
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })

    type Row = { id: string; created_at: string }
    const rows = (data ?? []) as unknown as Row[]
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? encodeDefaultCursor(last) : null

    return paginated(page, { requestId: ctx.requestId, nextCursor: nextCursor ?? undefined })
  },
)
