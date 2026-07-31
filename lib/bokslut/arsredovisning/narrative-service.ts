import type { SupabaseClient } from '@supabase/supabase-js'

export interface NarrativeOverrides {
  description: string | null
  important_events: string | null
  events_after_balance_sheet: string | null
  report_legal_name: string | null
  report_registered_office: string | null
  prior_legal_name: string | null
  resultatdisposition: string | null
  /** ISO date of the AGM (årsstämma) where the årsredovisning was adopted.
   *  Populates the fastställelseintyg date blank — without it the PDF
   *  cannot be filed at Bolagsverket without manual pen-and-ink edit. */
  agm_date: string | null
  agm_accounts_adopted: boolean | null
  agm_result_disposition_decision: string | null
  certificate_signer_name: string | null
  certificate_signer_role: string | null
  certificate_signed_at: string | null
  /** ÅRL 5:13 § — andel av långfristiga skulder som förfaller senare än
   *  fem år efter balansdagen. Null/0 → "Inga skulder förfaller efter mer
   *  än fem år." rendered in the note. */
  long_term_debt_over_five_years: number | null
  /** ÅRL 5:14 § — ställda säkerheter (panter, företagsinteckningar). Null
   *  → "Inga." */
  securities_pledged: string | null
  /** ÅRL 5:15 § — eventualförpliktelser (borgensåtaganden, garantier).
   *  Null → "Inga." */
  contingent_liabilities: string | null
  /** BFNAR 2016:10 kap. 19 / BFNAR 2012:1 kap. 8 — moderföretagets namn.
   *  Note is emitted only when this is set; org_number and city are
   *  optional follow-up details. */
  parent_company_name: string | null
  parent_company_org_number: string | null
  parent_company_city: string | null
}

/**
 * Shape returned from getNarrative / upsertNarrative. user_id and
 * created_at are deliberately excluded from the API projection (see
 * NARRATIVE_API_COLUMNS below).
 */
export interface NarrativeRow {
  id: string
  company_id: string
  fiscal_period_id: string
  description: string | null
  important_events: string | null
  events_after_balance_sheet: string | null
  report_legal_name: string | null
  report_registered_office: string | null
  prior_legal_name: string | null
  resultatdisposition: string | null
  agm_date: string | null
  agm_accounts_adopted: boolean | null
  agm_result_disposition_decision: string | null
  certificate_signer_name: string | null
  certificate_signer_role: string | null
  certificate_signed_at: string | null
  long_term_debt_over_five_years: number | null
  securities_pledged: string | null
  contingent_liabilities: string | null
  parent_company_name: string | null
  parent_company_org_number: string | null
  parent_company_city: string | null
  updated_at: string
}

const TABLE = 'arsredovisning_narratives'

// Explicit projection — keeps user_id and other internal audit fields out
// of API responses. GDPR Art.25.2 / ISO A.8.3 data-minimization: callers
// only need the narrative content + last-updated timestamp.
const NARRATIVE_API_COLUMNS =
  'id, company_id, fiscal_period_id, description, important_events, events_after_balance_sheet, report_legal_name, report_registered_office, prior_legal_name, resultatdisposition, agm_date, agm_accounts_adopted, agm_result_disposition_decision, certificate_signer_name, certificate_signer_role, certificate_signed_at, long_term_debt_over_five_years, securities_pledged, contingent_liabilities, parent_company_name, parent_company_org_number, parent_company_city, updated_at'

/**
 * Load persisted narrative overrides for a fiscal period. Returns null when
 * the user hasn't customised anything yet — caller then falls back to the
 * auto-generated boilerplate in buildArsredovisningData.
 */
export async function getNarrative(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<NarrativeRow | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select(NARRATIVE_API_COLUMNS)
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load narrative: ${error.message}`)
  return (data as NarrativeRow | null) ?? null
}

/**
 * Upsert narrative overrides for a fiscal period. Composite UNIQUE constraint
 * (company_id, fiscal_period_id) — see migration
 * 20260517160000_narrative_agm_date_and_composite_unique.sql — makes the
 * onConflict path resolve to an UPDATE within the same tenant, so repeated
 * saves cleanly replace prior content instead of stacking rows.
 */
export async function upsertNarrative(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  input: Partial<NarrativeOverrides>,
): Promise<NarrativeRow> {
  // Preserve fields omitted by partial API updates. The previous implementation
  // converted every missing property to null, so saving one disclosure could
  // silently clear AGM/signature data written in another editor.
  const existing = await getNarrative(supabase, companyId, fiscalPeriodId)
  const payload = {
    user_id: userId,
    company_id: companyId,
    fiscal_period_id: fiscalPeriodId,
    description: input.description !== undefined ? input.description : existing?.description ?? null,
    important_events:
      input.important_events !== undefined ? input.important_events : existing?.important_events ?? null,
    events_after_balance_sheet:
      input.events_after_balance_sheet !== undefined
        ? input.events_after_balance_sheet
        : existing?.events_after_balance_sheet ?? null,
    report_legal_name:
      input.report_legal_name !== undefined
        ? input.report_legal_name
        : existing?.report_legal_name ?? null,
    report_registered_office:
      input.report_registered_office !== undefined
        ? input.report_registered_office
        : existing?.report_registered_office ?? null,
    prior_legal_name:
      input.prior_legal_name !== undefined ? input.prior_legal_name : existing?.prior_legal_name ?? null,
    resultatdisposition:
      input.resultatdisposition !== undefined
        ? input.resultatdisposition
        : existing?.resultatdisposition ?? null,
    agm_date: input.agm_date !== undefined ? input.agm_date : existing?.agm_date ?? null,
    agm_accounts_adopted:
      input.agm_accounts_adopted !== undefined
        ? input.agm_accounts_adopted
        : existing?.agm_accounts_adopted ?? null,
    agm_result_disposition_decision:
      input.agm_result_disposition_decision !== undefined
        ? input.agm_result_disposition_decision
        : existing?.agm_result_disposition_decision ?? null,
    certificate_signer_name:
      input.certificate_signer_name !== undefined
        ? input.certificate_signer_name
        : existing?.certificate_signer_name ?? null,
    certificate_signer_role:
      input.certificate_signer_role !== undefined
        ? input.certificate_signer_role
        : existing?.certificate_signer_role ?? null,
    certificate_signed_at:
      input.certificate_signed_at !== undefined
        ? input.certificate_signed_at
        : existing?.certificate_signed_at ?? null,
    long_term_debt_over_five_years:
      input.long_term_debt_over_five_years !== undefined
        ? input.long_term_debt_over_five_years
        : existing?.long_term_debt_over_five_years ?? null,
    securities_pledged:
      input.securities_pledged !== undefined
        ? input.securities_pledged
        : existing?.securities_pledged ?? null,
    contingent_liabilities:
      input.contingent_liabilities !== undefined
        ? input.contingent_liabilities
        : existing?.contingent_liabilities ?? null,
    parent_company_name:
      input.parent_company_name !== undefined
        ? input.parent_company_name
        : existing?.parent_company_name ?? null,
    parent_company_org_number:
      input.parent_company_org_number !== undefined
        ? input.parent_company_org_number
        : existing?.parent_company_org_number ?? null,
    parent_company_city:
      input.parent_company_city !== undefined
        ? input.parent_company_city
        : existing?.parent_company_city ?? null,
  }
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'company_id,fiscal_period_id' })
    .select(NARRATIVE_API_COLUMNS)
    .single()
  if (error || !data) {
    throw new Error(`Failed to save narrative: ${error?.message ?? 'unknown'}`)
  }

  // R10: saving a narrative field IS the active confirmation of its text.
  // Record who confirmed what, when, and for which fiscal year in the
  // append-only confirmation log. Best-effort: the narrative save is the
  // primary operation; the confirmation is the audit trail on top.
  const confirmedFields: Array<{ field: string; text: string }> = []
  if (input.description != null) confirmedFields.push({ field: 'description', text: input.description })
  if (input.important_events != null)
    confirmedFields.push({ field: 'important_events', text: input.important_events })
  if (input.events_after_balance_sheet != null)
    confirmedFields.push({ field: 'events_after_balance_sheet', text: input.events_after_balance_sheet })
  if (input.report_legal_name != null)
    confirmedFields.push({ field: 'report_legal_name', text: input.report_legal_name })
  if (input.report_registered_office != null)
    confirmedFields.push({ field: 'report_registered_office', text: input.report_registered_office })
  if (input.prior_legal_name != null)
    confirmedFields.push({ field: 'prior_legal_name', text: input.prior_legal_name })
  if (input.resultatdisposition != null)
    confirmedFields.push({ field: 'resultatdisposition', text: input.resultatdisposition })
  if (input.agm_result_disposition_decision != null)
    confirmedFields.push({
      field: 'agm_result_disposition_decision',
      text: input.agm_result_disposition_decision,
    })
  for (const { field, text } of confirmedFields) {
    try {
      // text_version increments per (field, period): count existing rows.
      const { count } = await supabase
        .from('arsredovisning_narrative_confirmations')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('field', field)
      await supabase.from('arsredovisning_narrative_confirmations').insert({
        company_id: companyId,
        fiscal_period_id: fiscalPeriodId,
        field,
        confirmed_text: text,
        text_version: (count ?? 0) + 1,
        confirmed_by: userId,
      })
    } catch {
      // Non-blocking audit enrichment.
    }
  }

  return data as NarrativeRow
}
