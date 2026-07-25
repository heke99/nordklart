import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { checkFeatureAccess, NORDKLART_FEATURES } from '@/lib/platform/entitlements'

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

  const featureAccess = await checkFeatureAccess(
    ctx.supabase,
    ctx.companyId!,
    NORDKLART_FEATURES.bankgiroApplication,
  )

  if (!featureAccess.allowed) {
    if (featureAccess.reason === 'database_error') {
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          feature: NORDKLART_FEATURES.bankgiroApplication,
          reason: featureAccess.reason,
        },
      })
    }
    return v1ErrorResponseFromCode('FORBIDDEN', ctx.log, {
      requestId: ctx.requestId,
      details: {
        feature: NORDKLART_FEATURES.bankgiroApplication,
        reason: featureAccess.reason ?? 'missing_entitlement',
        message: 'Bankgiro-ansökan kräver en aktiv Bankgiro-tjänst eller uttrycklig Complimentary Bankgiro-access.',
      },
    })
  }

  if (ctx.dryRun) {
    return created({
      id: 'dry_run',
      company_id: ctx.companyId,
      provider_setup_status: 'not_started',
      documents_status: 'not_started',
      ...parsed.data,
    }, { requestId: ctx.requestId, dryRun: true })
  }

  const { data, error } = await ctx.supabase.rpc('request_bankgiro_application', {
    p_company_id: ctx.companyId!,
    p_provider_id: parsed.data.provider_id ?? null,
    p_status: parsed.data.status,
    p_expected_monthly_volume: parsed.data.expected_monthly_volume ?? null,
    p_use_case: parsed.data.use_case ?? null,
    p_beneficial_owners: parsed.data.beneficial_owners,
    p_company_questions: parsed.data.company_questions,
    p_volume_answers: parsed.data.volume_answers,
    p_requested_by: ctx.userId,
  })

  if (error) {
    return v1ErrorResponse(error, ctx.log, {
      requestId: ctx.requestId,
      status: error.code === '23505' ? 409 : error.code === '42501' ? 403 : undefined,
    })
  }

  const application = Array.isArray(data) ? data[0] : data
  if (!application) {
    return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, { requestId: ctx.requestId })
  }

  return created(application, { requestId: ctx.requestId })
})
