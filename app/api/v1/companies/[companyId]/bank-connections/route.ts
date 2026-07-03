/**
 * GET /api/v1/companies/{companyId}/bank-connections
 *
 * Read-only view of the company's PSD2 bank connections with canonical
 * status fields (connected / consent / sync) and the latest sync runs.
 * Connecting/disconnecting banks requires the interactive dashboard flow
 * (PSD2 SCA cannot run over an API key).
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse } from '@/lib/api/v1/errors'

const BankConnection = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  bank_name: z.string().nullable(),
  status: z.string(),
  consent_status: z.string().nullable(),
  sync_status: z.string().nullable(),
  consent_expires: z.string().nullable(),
  last_synced_at: z.string().nullable(),
  last_sync_error: z.string().nullable(),
  created_at: z.string(),
})

registerEndpoint({
  operation: 'bank_connections.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/bank-connections',
  summary: 'List PSD2 bank connections with status + recent sync runs.',
  description:
    'Returns every bank connection with its lifecycle status (pending/active/expired/error/revoked), consent status, sync status, consent expiry and the five most recent sync runs (bank_sync_runs). Read-only: PSD2 consent flows require the interactive dashboard (SCA).',
  useWhen:
    'Monitoring bank-feed health from an external system, or deciding whether to prompt the user to renew a consent.',
  doNotUseFor:
    'Creating or revoking connections (dashboard only). Listing transactions (use /transactions).',
  pitfalls: [
    'consent_expires close to now means the PSD2 consent needs renewal (~90/180 days per bank).',
    'sync_status=error with last_sync_error set indicates the most recent sync failed — the connection may still be active.',
  ],
  example: {
    response: {
      data: {
        connections: [
          {
            id: 'b1c2…',
            provider: 'enable_banking',
            bank_name: 'SEB',
            status: 'active',
            consent_status: 'active',
            sync_status: 'success',
            consent_expires: '2026-09-01T00:00:00Z',
            last_synced_at: '2026-07-01T05:00:00Z',
            last_sync_error: null,
            created_at: '2026-04-01T09:00:00Z',
          },
        ],
        recent_sync_runs: [],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bank:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: z.object({
      connections: z.array(BankConnection),
      recent_sync_runs: z.array(z.object({
        id: z.string().uuid(),
        bank_connection_id: z.string().uuid().nullable(),
        trigger_source: z.string(),
        status: z.string(),
        started_at: z.string(),
        finished_at: z.string().nullable(),
        transactions_imported: z.number(),
        error_message: z.string().nullable(),
      })),
    }),
  },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'bank_connections.list',
  async (_request, ctx) => {
    const [{ data: connections, error: connErr }, { data: runs, error: runsErr }] = await Promise.all([
      ctx.supabase
        .from('bank_connections')
        .select('id, provider, bank_name, status, consent_status, sync_status, consent_expires, last_synced_at, last_sync_error, created_at')
        .eq('company_id', ctx.companyId!)
        .order('created_at', { ascending: false })
        .limit(50),
      ctx.supabase
        .from('bank_sync_runs')
        .select('id, bank_connection_id, trigger_source, status, started_at, finished_at, transactions_imported, error_message')
        .eq('company_id', ctx.companyId!)
        .order('started_at', { ascending: false })
        .limit(5),
    ])

    if (connErr) return v1ErrorResponse(connErr, ctx.log, { requestId: ctx.requestId })
    if (runsErr) return v1ErrorResponse(runsErr, ctx.log, { requestId: ctx.requestId })

    return ok(
      { connections: connections ?? [], recent_sync_runs: runs ?? [] },
      { requestId: ctx.requestId },
    )
  },
)
