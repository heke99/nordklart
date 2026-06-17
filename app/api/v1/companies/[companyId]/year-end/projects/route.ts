import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const YearEndProject = z.object({
  id: z.string().uuid(),
  fiscal_period_id: z.string().uuid().nullable(),
  status: z.string(),
  source: z.string().nullable(),
  readiness_score: z.number().nullable(),
  export_package_status: z.string().nullable(),
  next_action: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const CreateYearEndProject = z.object({
  fiscal_period_id: z.string().uuid(),
  source: z.enum(['bookkeeping_module', 'one_time_purchase', 'agency', 'api', 'import']).default('api'),
  requires_purchase: z.boolean().optional(),
  access_source: z.enum(['subscription', 'one_time_purchase', 'manual_override', 'trial']).optional(),
  next_action: z.string().max(240).optional(),
})

const PROJECT_COLUMNS = 'id,fiscal_period_id,status,source,readiness_score,export_package_status,next_action,created_at,updated_at'

registerEndpoint({
  operation: 'year_end.projects.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/year-end/projects',
  summary: 'List year-end projects for a company.',
  description: 'Returns year-end projects, including readiness and export package status.',
  useWhen: 'You need to show or sync Nordklart year-end projects for a company.',
  doNotUseFor: 'Creating booked year-end journal entries. Those must use the bookkeeping endpoints and period-lock checks.',
  pitfalls: ['A project being ready for review is not the same as a locked fiscal year.', 'One-time purchase access is represented separately in year_end_purchase_access.'],
  example: { response: { data: [{ id: '11111111-1111-1111-1111-111111111111', status: 'draft', readiness_score: null }], meta: { request_id: 'req_…', api_version: '2026-05-12' } } },
  scope: 'year_end:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: z.object({ projects: z.array(YearEndProject) }) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>('year_end.projects.list', async (_request, ctx) => {
  const { data, error } = await ctx.supabase
    .from('year_end_projects')
    .select(PROJECT_COLUMNS)
    .eq('company_id', ctx.companyId!)
    .order('updated_at', { ascending: false })
    .limit(100)

  if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
  return paginated(data ?? [], { requestId: ctx.requestId })
})

registerEndpoint({
  operation: 'year_end.projects.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/year-end/projects',
  summary: 'Create a year-end project.',
  description: 'Starts a year-end project without posting journal entries or locking periods.',
  useWhen: 'You need to start a year-end workflow from an integration, SIE import flow, or one-time purchase.',
  doNotUseFor: 'Backdating or changing posted bookkeeping. This endpoint only starts workflow state.',
  pitfalls: ['Use Idempotency-Key for production clients.', 'This endpoint does not bypass feature gates or locked-period rules.'],
  example: { request: { fiscal_period_id: '11111111-1111-1111-1111-111111111111', source: 'api' }, response: { data: { id: '22222222-2222-2222-2222-222222222222', status: 'draft' }, meta: { request_id: 'req_…', api_version: '2026-05-12' } } },
  scope: 'year_end:write',
  risk: 'medium',
  idempotent: false,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateYearEndProject },
  response: { success: YearEndProject },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>('year_end.projects.create', async (request, ctx) => {
  const parsed = CreateYearEndProject.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, details: { issues: parsed.error.issues } })
  }

  if (ctx.dryRun) {
    return created({ id: 'dry_run', company_id: ctx.companyId, status: 'draft', ...parsed.data }, { requestId: ctx.requestId, dryRun: true })
  }

  const { data, error } = await ctx.supabase
    .from('year_end_projects')
    .insert({
      company_id: ctx.companyId!,
      fiscal_period_id: parsed.data.fiscal_period_id,
      source: parsed.data.source,
      status: 'draft',
      requires_purchase: parsed.data.requires_purchase ?? false,
      access_source: parsed.data.access_source ?? 'subscription',
      next_action: parsed.data.next_action ?? 'Kör readiness-kontroller',
    })
    .select(PROJECT_COLUMNS)
    .single()

  if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
  return created(data, { requestId: ctx.requestId })
})
