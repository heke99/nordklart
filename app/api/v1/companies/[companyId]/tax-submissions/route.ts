import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const TaxSubmission = z.object({
  id: z.string().uuid(),
  submission_type: z.string(),
  period_key: z.string().nullable(),
  status: z.string(),
  requires_signature: z.boolean(),
  due_date: z.string().nullable(),
  skatteverket_reference: z.string().nullable(),
  receipt_reference: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const CreateTaxSubmission = z.object({
  submission_type: z.enum(['vat_return', 'agi', 'skattekonto_reconciliation', 'income_tax', 'other']),
  period_key: z.string().max(50).optional(),
  fiscal_period_id: z.string().uuid().nullable().optional(),
  requires_signature: z.boolean().default(true),
  amount: z.number().optional(),
  due_date: z.string().date().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})

const COLUMNS = 'id,submission_type,period_key,status,requires_signature,due_date,skatteverket_reference,receipt_reference,error_message,created_at,updated_at'

registerEndpoint({
  operation: 'tax_submissions.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/tax-submissions',
  summary: 'List Skatteverket/tax submissions.',
  description: 'Returns VAT and tax submission workflow status for the company.',
  useWhen: 'You need to show whether a VAT return is prepared, sent, waiting for signature, submitted, or receipted.',
  doNotUseFor: 'Claiming a declaration is fully submitted before signing and receipt are present.',
  pitfalls: ['waiting_for_signature is a live action state, not a completed submission.', 'receipt_received is the safest final status for automation.'],
  example: { response: { data: [{ id: '11111111-1111-1111-1111-111111111111', submission_type: 'vat_return', status: 'prepared' }], meta: { request_id: 'req_…', api_version: '2026-05-12' } } },
  scope: 'tax:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: z.object({ submissions: z.array(TaxSubmission) }) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>('tax_submissions.list', async (_request, ctx) => {
  const { data, error } = await ctx.supabase.from('tax_submissions').select(COLUMNS).eq('company_id', ctx.companyId!).order('updated_at', { ascending: false }).limit(100)
  if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
  return paginated(data ?? [], { requestId: ctx.requestId })
})

registerEndpoint({
  operation: 'tax_submissions.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/tax-submissions',
  summary: 'Prepare a Skatteverket/tax submission.',
  description: 'Creates a prepared tax submission. It does not mark the declaration signed or receipted.',
  useWhen: 'You need to prepare a VAT return or other tax submission from an integration.',
  doNotUseFor: 'Skipping required signing. Use status transitions and receipt data when Skatteverket responds.',
  pitfalls: ['The default status is prepared.', 'requires_signature defaults to true for Swedish tax flows.'],
  example: { request: { submission_type: 'vat_return', period_key: '2026-05' }, response: { data: { id: '22222222-2222-2222-2222-222222222222', status: 'prepared' }, meta: { request_id: 'req_…', api_version: '2026-05-12' } } },
  scope: 'tax:write',
  risk: 'medium',
  idempotent: false,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateTaxSubmission },
  response: { success: TaxSubmission },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>('tax_submissions.create', async (request, ctx) => {
  const parsed = CreateTaxSubmission.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, details: { issues: parsed.error.issues } })

  if (ctx.dryRun) return created({ id: 'dry_run', company_id: ctx.companyId, status: 'prepared', ...parsed.data }, { requestId: ctx.requestId, dryRun: true })

  const now = new Date().toISOString()
  const { data, error } = await ctx.supabase
    .from('tax_submissions')
    .insert({
      company_id: ctx.companyId!,
      submission_type: parsed.data.submission_type,
      period_key: parsed.data.period_key ?? null,
      fiscal_period_id: parsed.data.fiscal_period_id ?? null,
      requires_signature: parsed.data.requires_signature,
      amount: parsed.data.amount ?? null,
      due_date: parsed.data.due_date ?? null,
      payload: parsed.data.payload ?? {},
      status: 'prepared',
      prepared_by: ctx.userId,
      prepared_at: now,
    })
    .select(COLUMNS)
    .single()

  if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
  return created(data, { requestId: ctx.requestId })
})
