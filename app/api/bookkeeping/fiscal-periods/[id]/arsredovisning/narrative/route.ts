import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import {
  getNarrative,
  upsertNarrative,
} from '@/lib/bokslut/arsredovisning/narrative-service'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { stripAnnualReportControlCharacters } from '@/lib/bokslut/arsredovisning/format'

const sanitizedText = (max: number) =>
  z
    .string()
    .max(max)
    .transform(stripAnnualReportControlCharacters)

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => {
      const date = new Date(`${value}T00:00:00Z`)
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    },
    { message: 'Invalid calendar date' },
  )

const PostSchema = z.object({
  // Match the DB CHECK lengths exactly so a payload that would fail at the
  // storage layer instead returns a clean 400 here. Free-text fields are
  // rendered verbatim into the årsredovisning PDF, so we strip ASCII
  // control bytes (NUL, ESC, etc.) at the schema layer — otherwise a
  // tampered payload could corrupt PDF output or hide content from auditors.
  description: sanitizedText(4000).nullable().optional(),
  important_events: sanitizedText(4000).nullable().optional(),
  events_after_balance_sheet: sanitizedText(4000).nullable().optional(),
  report_legal_name: sanitizedText(200).nullable().optional(),
  report_registered_office: sanitizedText(100).nullable().optional(),
  prior_legal_name: sanitizedText(200).nullable().optional(),
  resultatdisposition: sanitizedText(2000).nullable().optional(),
  // ISO YYYY-MM-DD per the DATE column; null clears it. Validate as a
  // real calendar date (not just regex) so '2024-13-99' returns 400 from
  // the API instead of bubbling up as a Postgres 500.
  agm_date: isoDate.nullable().optional(),
  agm_accounts_adopted: z.boolean().nullable().optional(),
  agm_result_disposition_decision: sanitizedText(2000).nullable().optional(),
  certificate_signer_name: sanitizedText(200).nullable().optional(),
  certificate_signer_role: sanitizedText(100).nullable().optional(),
  certificate_signed_at: isoDate.nullable().optional(),
  // Disclosure fields per ÅRL 5:13-15 § + BFNAR koncernförhållanden. All
  // optional; null clears the override and the builder falls back to
  // boilerplate ("Inga." / "Inga skulder förfaller efter mer än fem år.").
  // Cap at 1 trillion SEK — well above any realistic Swedish company's
  // long-term debt (Volvo Group ~500 G SEK), prevents overflow in PDF
  // formatting and downstream numeric handling.
  long_term_debt_over_five_years: z
    .number()
    .min(0)
    .max(1_000_000_000_000)
    .nullable()
    .optional(),
  securities_pledged: sanitizedText(4000).nullable().optional(),
  contingent_liabilities: sanitizedText(4000).nullable().optional(),
  parent_company_name: sanitizedText(200).nullable().optional(),
  // Swedish organisationsnummer NNNNNN-NNNN. Third digit ≥ 2 distinguishes
  // legal-entity org numbers from personnummer (whose third digit forms part
  // of a month, 0-1). ÅRL 5:13–15 disclosure is about parent legal entities,
  // so personnummer-shaped values are out of scope and a GDPR Art.5(1)(c)
  // data-minimisation concern if persisted. Empty string clears the override.
  parent_company_org_number: z
    .union([
      z.literal(''),
      z.string().regex(/^\d{2}[2-9]\d{3}-\d{4}$/, {
        message: 'Ogiltigt organisationsnummer (NNNNNN-NNNN, ej personnummer)',
      }),
    ])
    .nullable()
    .optional(),
  parent_company_city: sanitizedText(100).nullable().optional(),
})

export const GET = withRouteContext(
  'period.arsredovisning_narrative_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.arsredovisning_narrative_get',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      // Mirror the POST handler's period-ownership pre-check so a valid
      // JWT for company A can't probe / enumerate company B's period IDs
      // through this endpoint.
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      const data = await getNarrative(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)

export const POST = withRouteContext(
  'period.arsredovisning_narrative_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, PostSchema)
    if (!validation.success) return validation.response
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.arsredovisning_narrative_post',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      // The ledger lock and annual-report lock are separate. Narrative,
      // signer, AGM and disclosure edits do not create journal entries and
      // therefore remain editable after the fiscal period is closed. Only a
      // locked final annual-report version blocks document edits.
      const [{ data: period }, { data: project }] = await Promise.all([
        supabase
          .from('fiscal_periods')
          .select('id, ledger_locked')
          .eq('id', id)
          .eq('company_id', companyId)
          .maybeSingle(),
        supabase
          .from('annual_report_projects')
          .select('id, status, annual_report_locked')
          .eq('company_id', companyId)
          .eq('fiscal_period_id', id)
          .maybeSingle(),
      ])
      if (!period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      if (project?.annual_report_locked) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            code: 'ANNUAL_REPORT_LOCKED',
            reason: 'Slutversionen är låst. Skapa en ny årsredovisningsversion innan dokumentuppgifter ändras.',
            action: 'create_new_version',
          },
        })
      }
      const data = await upsertNarrative(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)
