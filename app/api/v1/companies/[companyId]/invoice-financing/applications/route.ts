/**
 * /api/v1/companies/{companyId}/invoice-financing/applications
 *
 * GET  — list financing applications (fakturafinansiering). Cursor
 *        pagination on (created_at ASC, id ASC), ?status filter.
 * POST — create an application for a sent customer invoice. Runs the
 *        eligibility check, submits to the provider and returns the
 *        offer (sandbox answers synchronously). Idempotent.
 */
import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
} from '@/lib/api/v1/pagination'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { createFinancingApplication } from '@/lib/invoice-financing/service'
import { ensureInitialized } from '@/lib/init'

const ApplicationSummary = z.object({
  id: z.string().uuid(),
  invoice_id: z.string().uuid(),
  provider_slug: z.string(),
  status: z.enum([
    'submitted', 'needs_more_info', 'offer_created', 'accepted',
    'rejected', 'paid_out', 'settled', 'recourse', 'cancelled',
  ]),
  recourse: z.boolean(),
  requested_amount: z.number(),
  currency: z.string(),
  provider_reference: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
})

const CreateApplicationSchema = z.object({
  invoice_id: z.string().uuid({ message: 'invoice_id måste vara ett giltigt UUID.' }),
  provider: z.string().min(1).max(50).optional(),
  recourse: z.boolean().optional(),
  consent_id: z.string().uuid().optional(),
})

const APPLICATION_COLUMNS =
  'id, invoice_id, provider_slug, status, recourse, requested_amount, currency, consent_id, provider_reference, error_message, created_at, updated_at'

registerEndpoint({
  operation: 'invoice_financing.applications.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/invoice-financing/applications',
  summary: 'List invoice-financing applications.',
  description:
    'Returns fakturafinansiering applications in created order. Filter by ?status. Each application tracks an invoice offered for sale (non-recourse) or pledging (recourse) to a financing provider.',
  useWhen: 'You need the financing pipeline: open offers, payouts, rejections.',
  doNotUseFor: 'Invoice payment status — read the invoice resource.',
  pitfalls: [
    'status=offer_created means an open offer awaits acceptance — offers expire (valid_until on the offer).',
    'Sandbox provider answers synchronously; production providers may answer via webhook (status stays submitted until then).',
  ],
  example: {
    response: {
      data: [
        {
          id: 'f1a2…',
          invoice_id: 'b3c4…',
          provider_slug: 'sandbox',
          status: 'offer_created',
          recourse: false,
          requested_amount: 12500,
          currency: 'SEK',
          created_at: '2026-07-01T09:00:00Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'financing:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: z.object({ applications: z.array(ApplicationSummary) }) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'invoice_financing.applications.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const statusParam = url.searchParams.get('status')
    const StatusFilter = z.enum([
      'submitted', 'needs_more_info', 'offer_created', 'accepted',
      'rejected', 'paid_out', 'settled', 'recourse', 'cancelled',
    ]).optional()
    const statusParse = StatusFilter.safeParse(statusParam ?? undefined)
    if (!statusParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'status', message: 'Ogiltig status.' },
      })
    }

    let query = ctx.supabase
      .from('invoice_financing_applications')
      .select(APPLICATION_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1)

    if (statusParse.data) query = query.eq('status', statusParse.data)
    if (decoded) {
      query = query.or(
        `created_at.gt.${decoded.ts},and(created_at.eq.${decoded.ts},id.gt.${decoded.id})`,
      )
    }

    const { data, error } = await query
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })

    const rows = (data ?? []) as Array<{ created_at: string; id: string }>
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? encodeDefaultCursor(last) : null

    return paginated(page, { requestId: ctx.requestId, nextCursor: nextCursor ?? undefined })
  },
)

registerEndpoint({
  operation: 'invoice_financing.applications.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoice-financing/applications',
  summary: 'Offer a sent customer invoice for financing.',
  description:
    'Creates a fakturafinansiering application. The invoice must be sent, fully unpaid, in SEK, without ROT/RUT, B2B with org number, and within the provider amount/due-date window — otherwise NOT_ELIGIBLE is returned with per-rule issues. The sandbox provider answers synchronously with an offer.',
  useWhen: 'The company wants to sell or borrow against a receivable.',
  doNotUseFor: 'Supplier-invoice payments — that is the AP payment-file flow.',
  pitfalls: [
    'One live application per invoice — a second POST returns CONFLICT until the first reaches a terminal state.',
    'Production providers require an external agreement; without one the endpoint returns PROVIDER_NOT_CONFIGURED.',
  ],
  example: {
    request: { invoice_id: 'b3c4…', recourse: false },
    response: {
      data: {
        application: { id: 'f1a2…', status: 'offer_created' },
        offer: { payout_amount: 12125, fee_amount: 375, fee_percent: 3 },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'financing:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: false,
  request: { body: CreateApplicationSchema },
  response: {
    success: z.object({
      application: ApplicationSummary,
      offer: z
        .object({
          id: z.string().uuid(),
          offered_amount: z.number(),
          fee_percent: z.number(),
          fee_amount: z.number(),
          payout_amount: z.number(),
          valid_until: z.string().nullable(),
        })
        .nullable(),
      message_sv: z.string(),
    }),
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'invoice_financing.applications.create',
  async (request, ctx) => {
    await ensureInitialized()

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = CreateApplicationSchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
        },
      })
    }

    const outcome = await createFinancingApplication(ctx.supabase, {
      companyId: ctx.companyId!,
      userId: ctx.userId,
      invoiceId: parsed.data.invoice_id,
      providerSlug: parsed.data.provider,
      recourse: parsed.data.recourse,
      consentId: parsed.data.consent_id ?? null,
    })

    if (!outcome.ok) {
      switch (outcome.code) {
        case 'NOT_FOUND':
          return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
            requestId: ctx.requestId,
            details: { resource: 'invoice', message: outcome.message_sv },
          })
        case 'ALREADY_ACTIVE':
          return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
            requestId: ctx.requestId,
            details: { message: outcome.message_sv },
          })
        case 'NOT_ELIGIBLE':
          return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
            requestId: ctx.requestId,
            details: {
              message: outcome.message_sv,
              issues: outcome.issues.map((i) => ({ code: i.code, message: i.message_sv })),
            },
          })
        case 'PROVIDER_NOT_CONFIGURED':
          return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
            requestId: ctx.requestId,
            details: { code: 'PROVIDER_NOT_CONFIGURED', message: outcome.message_sv },
          })
        default:
          return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
            requestId: ctx.requestId,
            details: { message: outcome.message_sv },
          })
      }
    }

    return created(
      {
        application: outcome.application,
        offer: outcome.offer,
        message_sv: outcome.message_sv,
      },
      { requestId: ctx.requestId },
    )
  },
)
