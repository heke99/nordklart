/**
 * GET /api/v1/companies/{companyId} — single company profile.
 *
 * The by-id companion to GET /api/v1/companies (list). Scope-checked and
 * membership-checked by the wrapper; returns 404 (not 403) on non-membership
 * to avoid resource-existence disclosure.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

const CompanyDetail = z.object({
  id: z.string().uuid(),
  name: z.string(),
  org_number: z.string().nullable(),
  entity_type: z.string(),
  created_at: z.string(),
  settings: z.object({
    vat_registered: z.boolean().nullable(),
    moms_period: z.string().nullable(),
    accounting_method: z.string().nullable(),
    fiscal_year_start_month: z.number().nullable(),
    f_skatt: z.boolean().nullable(),
  }).nullable(),
})

registerEndpoint({
  operation: 'companies.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId',
  summary: 'Retrieve a single company profile.',
  description:
    'Returns the company profile plus the accounting-relevant settings (VAT registration, moms period, accounting method, fiscal-year start, F-skatt). The API key must belong to a member of the company.',
  useWhen:
    'You resolved a company id from the list endpoint and need its settings before creating invoices or journal entries (e.g. accounting_method decides kontantmetoden vs faktureringsmetoden behaviour).',
  doNotUseFor:
    'Listing all accessible companies (use GET /api/v1/companies). Mutating settings (dashboard only in v1).',
  pitfalls: [
    'settings can be null for companies that have not completed onboarding.',
    'moms_period is null when the company is not VAT-registered.',
  ],
  example: {
    response: {
      data: {
        id: 'c0a8…',
        name: 'Acme AB',
        org_number: '556677-8899',
        entity_type: 'aktiebolag',
        created_at: '2025-01-04T08:00:00Z',
        settings: {
          vat_registered: true,
          moms_period: 'quarterly',
          accounting_method: 'accrual',
          fiscal_year_start_month: 1,
          f_skatt: true,
        },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'companies:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: CompanyDetail },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'companies.get',
  async (_request, ctx) => {
    const [{ data: company, error: companyErr }, { data: settings }] = await Promise.all([
      ctx.supabase
        .from('companies')
        .select('id, name, org_number, entity_type, created_at')
        .eq('id', ctx.companyId!)
        .maybeSingle(),
      ctx.supabase
        .from('company_settings')
        .select('vat_registered, moms_period, accounting_method, fiscal_year_start_month, f_skatt')
        .eq('company_id', ctx.companyId!)
        .maybeSingle(),
    ])

    if (companyErr) {
      return v1ErrorResponse(companyErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!company) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'company' },
      })
    }

    return ok(
      {
        ...company,
        settings: settings ?? null,
      },
      { requestId: ctx.requestId },
    )
  },
)
