import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const BankgiroApplication = z.object({
  id: z.string().uuid(),
  status: z.string(),
  provider_setup_status: z.string().nullable(),
  documents_status: z.string().nullable(),
  expected_monthly_volume: z.number().nullable(),
  risk_score: z.number().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const CreateBankgiroApplication = z.object({
  provider_id: z.string().uuid().nullable().optional(),
  status: z.enum(['draft', 'submitted']).default('draft'),
  expected_monthly_volume: z.number().nonnegative().optional(),
  use_case: z.string().max(500).optional(),
  beneficial_owners: z.array(z.record(z.string(), z.unknown())).default([]),
  company_questions: z.record(z.string(), z.unknown()).default({}),
  volume_answers: z.record(z.string(), z.unknown()).default({}),
})

const COLUMNS = 'id,status,provider_setup_status,documents_status,expected_monthly_volume,risk_score,created_at,updated_at'

registerEndpoint({
  operation: 'bankgiro_applications.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/bankgiro-applications',
  summary: 'List Bankgiro/Autogiro applications.',
  description: 'Returns Bankgiro/Autogiro onboarding and provider setup status for the company.',
  useWhen: 'You need to show payment-provider onboarding status without blocking ordinary bookkeeping.',
  doNotUseFor: 'Bank account data sync; that is bank automation, not Bankgiro/Autogiro.',
  pitfalls: ['Bankgiro is a separate add-on flow.', 'provider_setup_status can still be pending after an application is approved.'],
  example: { response: { data: [{ id: '11111111-1111-1111-1111-111111111111', status: 'under_review' }], meta: { request_id: 'req_…', api_version: '2026-05-12' } } },
  scope: 'bankgiro:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: z.object({ applications: z.array(BankgiroApplication) }) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>('bankgiro_applications.list', async (_request, ctx) => {
  const { data, error } = await ctx.supabase.from('bankgiro_applications').select(COLUMNS).eq('company_id', ctx.companyId!).order('updated_at', { ascending: false }).limit(100)
  if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
  return paginated(data ?? [], { requestId: ctx.requestId })
})

registerEndpoint({
  operation: 'bankgiro_applications.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/bankgiro-applications',
  summary: 'Create a Bankgiro/Autogiro application.',
  description: 'Creates a separate payment-provider onboarding application for Bankgiro/Autogiro.',
  useWhen: 'You need to start Bankgiro/Autogiro onboarding for a company.',
  doNotUseFor: 'Forcing every bookkeeping customer through payment-provider onboarding.',
  pitfalls: ['Submitted applications should still be reviewed by platform admin.', 'Documents and provider setup are tracked separately.'],
  example: { request: { status: 'submitted', expected_monthly_volume: 250000 }, response: { data: { id: '22222222-2222-2222-2222-222222222222', status: 'submitted' }, meta: { request_id: 'req_…', api_version: '2026-05-12' } } },
  scope: 'bankgiro:write',
  risk: 'medium',
  idempotent: false,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateBankgiroApplication },
  response: { success: BankgiroApplication },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>('bankgiro_applications.create', async (request, ctx) => {
  const parsed = CreateBankgiroApplication.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, details: { issues: parsed.error.issues } })

  if (ctx.dryRun) return created({ id: 'dry_run', company_id: ctx.companyId, provider_setup_status: 'not_started', documents_status: 'not_started', ...parsed.data }, { requestId: ctx.requestId, dryRun: true })

  const { data, error } = await ctx.supabase
    .from('bankgiro_applications')
    .insert({
      company_id: ctx.companyId!,
      provider_id: parsed.data.provider_id ?? null,
      status: parsed.data.status,
      expected_monthly_volume: parsed.data.expected_monthly_volume ?? null,
      use_case: parsed.data.use_case ?? null,
      beneficial_owners: parsed.data.beneficial_owners,
      company_questions: parsed.data.company_questions,
      volume_answers: parsed.data.volume_answers,
      documents_status: 'not_started',
      provider_setup_status: 'not_started',
    })
    .select(COLUMNS)
    .single()

  if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
  return created(data, { requestId: ctx.requestId })
})
