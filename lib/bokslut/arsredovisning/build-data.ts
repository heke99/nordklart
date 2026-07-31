import type { SupabaseClient } from '@supabase/supabase-js'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateKassaflodesanalys } from '@/lib/reports/kassaflodesanalys'
import { listAssets } from '@/lib/bokslut/assets/asset-service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { LATENT_TAX_DEFAULT_RATE } from '@/lib/bokslut/tax-provision/latent-tax-calculator'
import { getNarrative, type NarrativeRow } from './narrative-service'
import { listSignatureRequests } from './signature-service'
import {
  anyAssetHasComponents,
  buildEquityChangesNote,
  buildK3RedovisningsPrinciper,
  buildMateriellaAnlaggningsNot,
  buildUppskjutenSkattNot,
} from './k3-noter-builder'
import { buildAnlaggningstillgangarNote } from './anlaggningstillgangar-note'
import { computeMedelantalAnstallda } from '@/lib/salary/medelantal'
import { roundOre } from '@/lib/money'
import {
  applyVerifiedComparativeSnapshot,
  applyPresentationReclassifications,
  buildK2FormalReportModel,
  formalBalanceSheetLines,
  formalIncomeStatementLines,
  type K2FormalReportModel,
} from '@/lib/bokslut/formal-report/k2-model'
import {
  loadVerifiedComparativeSnapshot,
  overviewRowFromSnapshot,
  type VerifiedComparativeSnapshot,
} from './comparatives'
import { buildK2EquityRollforward } from './equity-rollforward'
import type {
  ArsredovisningData,
  EgenKapitalRow,
  FlerarsoversiktRow,
  IncomeStatementLine,
  BalanceSheetLine,
  NoteEntry,
  KassaflodesAnalysisSummary,
} from './types'
import type {
  AccountingFramework,
  Asset,
  BalanceSheetSection,
  IncomeStatementSection,
} from '@/types'

/**
 * Pre-populate the K2 årsredovisning data for a fiscal period. Loads:
 *   - Income statement + balance sheet for the current period
 *   - Up to 3 prior periods for the flerårsöversikt
 *   - Asset register so noter can list avskrivningstider per category
 *   - Active employees count for medelantal anställda
 *   - Equity-account movements for förändring av eget kapital
 *
 * Manually-authored fields (description, important_events,
 * resultatdisposition, ställda säkerheter, eventualförpliktelser) are
 * pre-filled with sensible boilerplate the user can replace. The narrative
 * editor in the UI persists overrides via /api/.../arsredovisning POST.
 */
export async function buildArsredovisningData(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  overrides: Partial<ArsredovisningData['forvaltningsberattelse']> = {},
): Promise<ArsredovisningData> {
  const [periodResult, settingsResult, companyResult, periodList, incomeStatement, balanceSheet, narrative] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, previous_period_id, closing_entry_id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('company_name, org_number, address, entity_type')
      .eq('company_id', companyId)
      .maybeSingle(),
    // Source-of-truth for entity_type and accounting_framework lives on
    // companies. company_settings.entity_type is a legacy mirror; the
    // framework column was added later and only exists on companies.
    supabase
      .from('companies')
      .select('entity_type, accounting_framework')
      .eq('id', companyId)
      .maybeSingle(),
    fetchAllRows(({ from, to }) =>
      supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('company_id', companyId)
        .order('period_start', { ascending: false })
        .range(from, to),
    ),
    generateIncomeStatement(supabase, companyId, fiscalPeriodId),
    generateBalanceSheet(supabase, companyId, fiscalPeriodId),
    // Load persisted narrative overrides — replaces the URL-query-param
    // carry from earlier phases. Caller-supplied overrides (passed in via
    // the second arg) still win, so the API can layer per-request edits on
    // top of the saved baseline if needed.
    getNarrative(supabase, companyId, fiscalPeriodId).catch(() => null),
  ])

  if (periodResult.error || !periodResult.data) {
    throw new Error('Fiscal period not found')
  }
  const period = periodResult.data
  const settings = settingsResult.data
  const lockedCompanySnapshot = await loadLockedCompanySnapshot(
    supabase,
    companyId,
    fiscalPeriodId,
  )
  const structuredDisposition = await loadStructuredProfitDisposition(
    supabase,
    companyId,
    fiscalPeriodId,
  )
  const companyRow = companyResult.data as
    | { entity_type?: string | null; accounting_framework?: AccountingFramework | null }
    | null
  const companyName =
    narrative?.report_legal_name
    ?? lockedCompanySnapshot?.legal_name
    ?? settings?.company_name
    ?? 'Bolaget'
  const orgNumber =
    lockedCompanySnapshot?.organisation_number ?? settings?.org_number ?? ''
  // Default to 'unknown' (not 'aktiebolag') when entity_type isn't set —
  // otherwise the K2 guard in buildK2Noter would claim K2 for every
  // unconfigured company, which is exactly the false-assertion the guard
  // was added to prevent. Prefer the companies row over company_settings
  // since the multi-tenant refactor made companies the source of truth.
  const entityType =
    companyRow?.entity_type
    ?? (settings as { entity_type?: string } | null)?.entity_type
    ?? 'unknown'
  // K3 is opt-in; only AB ever set it. Default to K2 when not set.
  const accountingFramework: AccountingFramework =
    companyRow?.accounting_framework === 'k3' ? 'k3' : 'k2'

  type AddressShape = { city?: string | null; postal_city?: string | null } | null
  const addressUnknown = (settings as { address?: AddressShape } | null)?.address ?? null
  const city =
    narrative?.report_registered_office
    ?? lockedCompanySnapshot?.registered_office
    ?? lockedCompanySnapshot?.city
    ?? (addressUnknown && (addressUnknown.city ?? addressUnknown.postal_city))
    ?? null

  // Merge precedence: caller overrides → persisted narrative → boilerplate
  const persistedDescription = narrative?.description ?? undefined
  const persistedEvents = narrative?.important_events ?? undefined
  const persistedAfterBalance = narrative?.events_after_balance_sheet ?? undefined
  const persistedPriorLegalName = narrative?.prior_legal_name ?? undefined
  const persistedRd = narrative?.resultatdisposition ?? undefined
  const persistedAgmDate = narrative?.agm_date ?? null

  // Signatures from the canonical signature model (R04) — the PDF must show
  // the real signatories, never generic placeholders.
  const signatureRequests = await listSignatureRequests(
    supabase,
    companyId,
    fiscalPeriodId,
  ).catch(() => [])

  // Comparison figures must come from an established/final/manual verified
  // annual-report snapshot. A live query against the prior ledger would let a
  // later import/reopen silently rewrite already published comparatives.
  let verifiedComparative: VerifiedComparativeSnapshot | null = null
  let priorPeriodMeta: ArsredovisningData['prior_period'] = null
  if (period.previous_period_id) {
    const { data: priorPeriodRow } = await supabase
      .from('fiscal_periods')
      .select('id, name')
      .eq('id', period.previous_period_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (priorPeriodRow) {
      verifiedComparative = await loadVerifiedComparativeSnapshot(
        supabase,
        companyId,
        priorPeriodRow.id as string,
      ).catch(() => null)
      let verifiedByName: string | null = null
      if (verifiedComparative?.verified_by) {
        const { data: verifierProfile } = await supabase
          .from('profiles')
          .select('full_name')
          .eq('id', verifiedComparative.verified_by)
          .maybeSingle()
        verifiedByName = verifierProfile?.full_name?.trim() || null
      }
      priorPeriodMeta = {
        id: priorPeriodRow.id as string,
        name: priorPeriodRow.name as string,
        source_type: verifiedComparative?.source_type ?? null,
        source_label: verifiedComparative?.source_label ?? null,
        verified_at: verifiedComparative?.verified_at ?? null,
        verified_by: verifiedByName,
      }
    }
  }

  const flerarsoversikt = await buildFlerarsoversikt(
    supabase,
    companyId,
    fiscalPeriodId,
    (periodList ?? []) as Array<{ id: string; name: string; period_start: string; period_end: string }>,
    accountingFramework,
  )

  let egen_kapital_changes = buildEquityChanges(balanceSheet.equity_liability_sections)
  const equityWarnings: string[] = []

  // K3 vs K2 split: K3 has a richer note set + a kassaflöde + a separate
  // equity-changes statement. The 18a/b warning that flagged "K3 noter not
  // yet emitted" is removed below now that we actually emit them.
  const { notes: noter, warnings: noterWarnings } =
    accountingFramework === 'k3'
      ? await buildK3Noter(
          supabase,
          companyId,
          fiscalPeriodId,
          entityType,
          period.period_start,
          period.period_end,
          narrative,
        )
      : await buildK2Noter(
          supabase,
          companyId,
          entityType,
          period.period_start,
          period.period_end,
          narrative,
        )
  const annualReportAnnotations = await loadAnnualReportAnnotations(
    supabase,
    companyId,
    fiscalPeriodId,
  )
  for (const annotation of annualReportAnnotations) {
    noter.push({
      number: noter.length + 1,
      title: annotation.target_id || 'Övrig upplysning',
      body: annotation.annotation_text,
    })
  }

  // Kassaflödesanalys + separate equity-changes statement — K3 only. K2
  // mindre företag is exempt from kassaflödesanalys (BFNAR 2016:10 punkt
  // 5.2) and keeps equity changes inside förvaltningsberättelsen.
  let kassaflodesanalys: KassaflodesAnalysisSummary | undefined
  let equity_changes_statement:
    | { rows: EgenKapitalRow[]; closing_total: number }
    | undefined
  if (accountingFramework === 'k3') {
    try {
      const cashFlow = await generateKassaflodesanalys(
        supabase,
        companyId,
        fiscalPeriodId,
      )
      // Strip fiscal_period_id from the embedded report — period info is
      // already on ArsredovisningData.fiscal_period; carrying it twice in
      // the payload would be redundant.
      kassaflodesanalys = {
        period_start: cashFlow.period_start,
        period_end: cashFlow.period_end,
        lopande: cashFlow.lopande,
        investerings: cashFlow.investerings,
        finansierings: cashFlow.finansierings,
        total_cash_flow: cashFlow.total_cash_flow,
        reconciliation: cashFlow.reconciliation,
      }
    } catch (cashFlowErr) {
      // K3 REQUIRES a kassaflödesanalys (BFNAR 2012:1 / ÅRL). A technical
      // failure must BLOCK the K3 document (R08) — a seemingly-complete PDF
      // without the mandatory statement is worse than an error.
      throw new Error(
        `Kassaflödesanalysen kunde inte genereras (${cashFlowErr instanceof Error ? cashFlowErr.message : 'okänt fel'}). ` +
          'K3-årsredovisning kan inte upprättas utan kassaflödesanalys — kontrollera att ingående och utgående saldon på 19xx finns och kör om bokslutet.',
      )
    }

    // Equity-changes statement — derived from the saved equity rows + this
    // year's resultat. We reuse buildEquityChangesNote's roll-forward to
    // keep one source of truth for the closing total.
    equity_changes_statement = await buildK3EquityChangesStatement(
      supabase,
      companyId,
      fiscalPeriodId,
      balanceSheet.equity_liability_sections,
      incomeStatement.net_result,
    )
  }

  let formal_report: K2FormalReportModel | undefined
  let resultatrakning: IncomeStatementLine[]
  let balansrakning: ArsredovisningData['balansrakning']

  if (accountingFramework === 'k2') {
    const [currentFull, currentPreClosing] = await Promise.all([
      generateTrialBalance(supabase, companyId, fiscalPeriodId),
      generateTrialBalance(supabase, companyId, fiscalPeriodId, {
        excludeYearEndClosing: true,
      }),
    ])

    formal_report = buildK2FormalReportModel(
      { full: currentFull.rows, preClosing: currentPreClosing.rows },
      null,
    )
    if (verifiedComparative?.formal_report_snapshot) {
      formal_report = applyVerifiedComparativeSnapshot(
        formal_report,
        verifiedComparative.formal_report_snapshot,
      )
    }
    const { data: presentationRows, error: presentationError } = await supabase
      .from('annual_report_presentation_reclassifications')
      .select('id, account_number, source_concept, target_concept, amount, reason')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .is('revoked_at', null)
      .order('created_at')
    if (presentationError) {
      throw new Error(`Presentationsomklassificeringar kunde inte hämtas: ${presentationError.message}`)
    }
    formal_report = applyPresentationReclassifications(
      formal_report,
      (presentationRows ?? []).map((row: {
        id: unknown
        account_number: unknown
        source_concept: unknown
        target_concept: unknown
        amount: unknown
        reason: unknown
      }) => ({
        id: String(row.id),
        account_number: String(row.account_number),
        source_concept: String(row.source_concept),
        target_concept: String(row.target_concept),
        amount: Number(row.amount),
        reason: String(row.reason),
      })),
    )
    const equityRollforward = await buildK2EquityRollforward(
      supabase,
      companyId,
      fiscalPeriodId,
      formal_report,
    )
    egen_kapital_changes = equityRollforward.rows
    equityWarnings.push(...equityRollforward.warnings)
    resultatrakning = formalIncomeStatementLines(formal_report)
    balansrakning = formalBalanceSheetLines(formal_report)

    // The current flerårsöversikt row must use the exact same classified K2
    // model as the statements. This prevents an abnormal debtor balance on a
    // liability account from inflating soliditet or letting the overview use
    // result after tax instead of result after financial items.
    const currentOverview = flerarsoversikt.find((row) => row.year === period.name)
    if (currentOverview) {
      const totalAssets = formal_report.totals.tillgangar.current
      const adjustedEquity =
        formal_report.totals.egetKapital.current
        + formal_report.totals.obeskattadeReserver.current * (1 - LATENT_TAX_DEFAULT_RATE)
      currentOverview.net_revenue = Math.round(
        formal_report.rr.Nettoomsattning?.current ?? 0,
      )
      currentOverview.result_after_financial = Math.round(
        formal_report.totals.resultatEfterFinansiellaPoster.current,
      )
      currentOverview.soliditet_pct =
        totalAssets > 0
          ? Math.round((adjustedEquity / totalAssets) * 1000) / 10
          : null
      currentOverview.data_missing = false
    }
  } else {
    resultatrakning = flattenIncomeStatement(incomeStatement)
    balansrakning = flattenBalanceSheet(balanceSheet)

    // K3 comparison figures also require a verified K3 snapshot. The current
    // snapshot schema stores the canonical K2 formal model, so no live prior
    // ledger fallback is allowed here. Finalization preflight reports the
    // missing verified K3 comparatives explicitly.
  }

  const warnings: string[] = [...noterWarnings, ...equityWarnings]
  if (priorPeriodMeta && !verifiedComparative) {
    warnings.push(
      `Jämförelsetal ${priorPeriodMeta.name} saknar verifierad källa. Importera föregående fastställda årsredovisning eller registrera manuellt verifierade jämförelsetal.`,
    )
  }
  for (const overviewRow of flerarsoversikt) {
    if (overviewRow.soliditet_pct !== null && overviewRow.soliditet_pct > 100) {
      warnings.push(
        `Soliditeten för ${overviewRow.year} överstiger 100 %. Kontrollera negativa skulder, nettning och onormala saldoriktningar.`,
      )
    }
  }
  if (entityType !== 'aktiebolag' && entityType !== 'unknown') {
    warnings.push(
      'Den här årsredovisningen genereras med K2-mallen (BFNAR 2016:10) som standard. För K3- eller annan företagsform kan strukturen behöva justeras manuellt innan inlämning.',
    )
  }
  if (entityType === 'aktiebolag' && accountingFramework === 'k3') {
    // Soliditet now reflects the K3 split (79,4 % equity portion of 21xx is
    // folded into eget kapital). 18e/f provides the K3 noter, kassaflöde
    // and separate equity-changes statement so the PDF is now substantively
    // K3-compliant; we keep a soft notice here so the filer remembers to
    // verify the document against their specific obligations before sending
    // to Bolagsverket.
    warnings.push(
      'Bolaget redovisar enligt K3 (BFNAR 2012:1). Soliditeten är beräknad med 79,4 % av obeskattade reserver inräknat i eget kapital. PDF:en innehåller kassaflödesanalys, förändring av eget kapital och utökade noter — granska innehållet mot er specifika redovisning innan inlämning.',
    )
  }
  if (entityType === 'unknown') {
    warnings.push(
      'Företagsform saknas i inställningarna — fyll i Inställningar → Företag för att få rätt redovisningsprinciper i not 1.',
    )
  }
  if (!persistedAgmDate) {
    warnings.push(
      'Datum för årsstämma saknas. Fastställelseintyget i PDF:en lämnas tomt på datumraden tills det fylls i nedan.',
    )
  } else {
    // ÅRL 8 kap 3 § + ÅRL 7 kap 10 §: AGM must be held after the räkenskapsår
    // ends and within 6 months of period end (för privat AB). A date before
    // period_end is logically impossible; after the deadline is a legally
    // defective fastställelseintyg.
    if (persistedAgmDate <= period.period_end) {
      warnings.push(
        `Datum för årsstämma (${persistedAgmDate}) ligger på eller före räkenskapsårets slut (${period.period_end}) — fastställelseintyget blir juridiskt felaktigt. Kontrollera datumet.`,
      )
    } else {
      const periodEndDate = new Date(`${period.period_end}T00:00:00Z`)
      const deadline = new Date(periodEndDate)
      deadline.setUTCMonth(deadline.getUTCMonth() + 6)
      const deadlineIso = deadline.toISOString().slice(0, 10)
      if (persistedAgmDate > deadlineIso) {
        warnings.push(
          `Datum för årsstämma (${persistedAgmDate}) är efter 6-månadersgränsen (${deadlineIso}). För privat AB ska årsstämman hållas inom 6 månader från räkenskapsårets slut (ÅRL 7 kap 10 §).`,
        )
      }
    }
  }

  // R10: standard texts asserting factual circumstances must be actively
  // confirmed. A field is "unconfirmed" when neither a caller override nor
  // a user-persisted narrative exists — the boilerplate below would
  // otherwise be published as a factual statement.
  const unconfirmedDefaults: string[] = []
  if (overrides.description === undefined && persistedDescription === undefined) {
    unconfirmedDefaults.push('description')
  }
  if (overrides.important_events === undefined && persistedEvents === undefined) {
    unconfirmedDefaults.push('important_events')
  }
  if (persistedAfterBalance === undefined) {
    unconfirmedDefaults.push('events_after_balance_sheet')
  }
  if (
    overrides.resultatdisposition === undefined
    && persistedRd === undefined
    && structuredDisposition === null
  ) {
    unconfirmedDefaults.push('resultatdisposition')
  }
  if (unconfirmedDefaults.length > 0) {
    warnings.push(
      `Förvaltningsberättelsen innehåller obekräftade standardtexter (${unconfirmedDefaults.join(', ')}). ` +
        'Granska och spara texterna innan slutlig årsredovisning kan genereras (utkast tills dess).',
    )
  }
  if (signatureRequests.length === 0) {
    warnings.push(
      'Inga undertecknare är registrerade. Lägg till styrelseledamöter/VD under Underskrifter innan slutlig årsredovisning genereras.',
    )
  }

  return {
    company: {
      name: companyName,
      org_number: orgNumber,
      city,
      prior_legal_name: persistedPriorLegalName ?? null,
    },
    fiscal_period: {
      id: period.id,
      name: period.name,
      period_start: period.period_start,
      period_end: period.period_end,
    },
    accounting_framework: accountingFramework,
    formal_report,
    forvaltningsberattelse: {
      description:
        overrides.description ??
        persistedDescription ??
        '[Verksamhetsbeskrivning saknas – beskriv vad bolaget faktiskt har gjort och hur intäkterna har uppkommit.]',
      important_events:
        overrides.important_events ??
        persistedEvents ??
        '[Väsentliga händelser under året har inte verifierats.]',
      events_after_balance_sheet:
        persistedAfterBalance ??
        '[Händelser efter balansdagen har inte verifierats.]',
      kontrollbalans_required: overrides.kontrollbalans_required ?? false,
      flerarsoversikt,
      egen_kapital_changes,
      resultatdisposition:
        overrides.resultatdisposition ??
        persistedRd ??
        structuredDisposition ??
        'Styrelsen föreslår att årets resultat balanseras i ny räkning.',
      agm_date: persistedAgmDate,
      agm_accounts_adopted: narrative?.agm_accounts_adopted ?? null,
      agm_result_disposition_decision:
        narrative?.agm_result_disposition_decision ?? null,
      certificate_signer_name: narrative?.certificate_signer_name ?? null,
      certificate_signer_role: narrative?.certificate_signer_role ?? null,
      certificate_signed_at: narrative?.certificate_signed_at ?? null,
    },
    resultatrakning,
    warnings,
    balansrakning,
    noter,
    kassaflodesanalys,
    equity_changes_statement,
    signatures: signatureRequests.map((r) => ({
      role: r.role,
      name: r.signer_name,
      signed_at: r.signed_at,
      status: r.status,
    })),
    prior_period: priorPeriodMeta,
    unconfirmed_defaults: unconfirmedDefaults,
    disclosures: {
      long_term_debt_over_five_years: narrative?.long_term_debt_over_five_years ?? null,
      securities_pledged: narrative?.securities_pledged ?? null,
      contingent_liabilities: narrative?.contingent_liabilities ?? null,
      parent_company_name: narrative?.parent_company_name ?? null,
      parent_company_org_number: narrative?.parent_company_org_number ?? null,
      parent_company_city: narrative?.parent_company_city ?? null,
    },
  }
}

interface LockedCompanySnapshot {
  organisation_number: string
  legal_name: string
  city: string | null
  registered_office: string | null
}

async function loadLockedCompanySnapshot(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<LockedCompanySnapshot | null> {
  try {
    const { data, error } = await supabase
      .from('year_end_company_snapshots')
      .select('organisation_number, legal_name, city, registered_office')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .not('locked_at', 'is', null)
      .is('superseded_at', null)
      .order('locked_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data as LockedCompanySnapshot | null
  } catch {
    // Forward-compatible while the migration is being rolled out. Final
    // generation is still blocked by year_end_control_status until a locked
    // snapshot exists.
    return null
  }
}

async function loadStructuredProfitDisposition(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('year_end_profit_dispositions')
      .select(
        'current_year_result, proposed_dividend, carried_forward, narrative_override, status',
      )
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .in('status', ['approved', 'locked'])
      .maybeSingle()
    if (error || !data) return null
    if (data.narrative_override) return String(data.narrative_override)

    const dividend = Number(data.proposed_dividend) || 0
    const carried = Number(data.carried_forward) || 0
    const format = (value: number) =>
      new Intl.NumberFormat('sv-SE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)
    return dividend > 0
      ? `Styrelsen föreslår att ${format(dividend)} kr lämnas i utdelning och att ${format(carried)} kr balanseras i ny räkning.`
      : `Styrelsen föreslår att ${format(carried)} kr balanseras i ny räkning.`
  } catch {
    return null
  }
}

async function loadAnnualReportAnnotations(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<Array<{ target_id: string | null; annotation_text: string }>> {
  try {
    const { data, error } = await supabase
      .from('year_end_annotations')
      .select('target_id, annotation_text')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .eq('visibility', 'annual_report')
      .is('superseded_at', null)
      .order('created_at')
    if (error) throw error
    return (data ?? []) as Array<{ target_id: string | null; annotation_text: string }>
  } catch {
    return []
  }
}

interface PeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
}

async function buildFlerarsoversikt(
  supabase: SupabaseClient,
  companyId: string,
  currentPeriodId: string,
  allPeriods: PeriodRow[],
  accountingFramework: AccountingFramework,
): Promise<FlerarsoversiktRow[]> {
  // Current year is computed from the current locked ledger. Historical rows
  // are accepted only from a verified annual-report snapshot.
  const sorted = [...allPeriods].sort((a, b) => a.period_start.localeCompare(b.period_start))
  const currentIdx = sorted.findIndex((period) => period.id === currentPeriodId)
  if (currentIdx === -1) return []
  const slice = sorted.slice(Math.max(0, currentIdx - 3), currentIdx + 1)
  const rows: FlerarsoversiktRow[] = []

  for (const period of slice) {
    if (period.id !== currentPeriodId) {
      const snapshot = await loadVerifiedComparativeSnapshot(
        supabase,
        companyId,
        period.id,
      ).catch(() => null)
      const verifiedRow = snapshot ? overviewRowFromSnapshot(snapshot, period.name) : null
      rows.push(
        verifiedRow ?? {
          year: period.name,
          net_revenue: 0,
          result_after_financial: 0,
          soliditet_pct: null,
          data_missing: true,
        },
      )
      continue
    }

    try {
      const [incomeStatement, trialBalance] = await Promise.all([
        generateIncomeStatement(supabase, companyId, period.id),
        generateTrialBalance(supabase, companyId, period.id),
      ])
      const totalAssets = trialBalance.rows
        .filter((row) => row.account_class === 1)
        .reduce((sum, row) => sum + (row.closing_debit - row.closing_credit), 0)
      const baseEquity = trialBalance.rows
        .filter((row) => row.account_number.startsWith('20'))
        .reduce((sum, row) => sum + (row.closing_credit - row.closing_debit), 0)
      let equity = baseEquity
      if (accountingFramework === 'k3') {
        const untaxedReserves = trialBalance.rows
          .filter((row) => row.account_number.startsWith('21'))
          .reduce((sum, row) => sum + (row.closing_credit - row.closing_debit), 0)
        equity += untaxedReserves * (1 - LATENT_TAX_DEFAULT_RATE)
      }
      rows.push({
        year: period.name,
        net_revenue: Math.round(incomeStatement.total_revenue),
        result_after_financial: Math.round(
          incomeStatement.total_revenue
            - incomeStatement.total_expenses
            + incomeStatement.total_financial,
        ),
        soliditet_pct:
          totalAssets > 0 ? Math.round((equity / totalAssets) * 1000) / 10 : null,
      })
    } catch {
      rows.push({
        year: period.name,
        net_revenue: 0,
        result_after_financial: 0,
        soliditet_pct: null,
        data_missing: true,
      })
    }
  }
  return rows
}

function buildEquityChanges(sections: BalanceSheetSection[]): EgenKapitalRow[] {
  // R06: only 20xx is eget kapital. 21xx (periodiseringsfonder,
  // överavskrivningar m.fl.) are OBESKATTADE RESERVER — partially deferred
  // tax, never equity in the förändring-av-eget-kapital table (K2/ÅRL).
  const equity: EgenKapitalRow[] = []
  for (const section of sections) {
    for (const row of section.rows) {
      if (row.account_number.startsWith('20')) {
        equity.push({
          label: `${row.account_number} ${row.account_name}`,
          amount: row.amount,
        })
      }
    }
  }
  return equity
}

async function buildK2Noter(
  supabase: SupabaseClient,
  companyId: string,
  entityType: string,
  periodStart: string,
  periodEnd: string,
  narrative: NarrativeRow | null,
): Promise<{ notes: NoteEntry[]; warnings: string[] }> {
  const notes: NoteEntry[] = []
  const warnings: string[] = []
  // Note 1: framework. Only claim K2 explicitly when we know the company is
  // an AB and using K2 — otherwise emit a generic principles note so the
  // ÅR doesn't falsely assert a framework the company isn't on.
  // K3 election isn't yet tracked separately; we treat any non-AB as not-K2.
  const isAbK2 = entityType === 'aktiebolag'
  notes.push({
    number: 1,
    title: 'Redovisnings- och värderingsprinciper',
    body: isAbK2
      ? 'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen och Bokföringsnämndens allmänna råd BFNAR 2016:10 Årsredovisning i mindre företag (K2).'
      : 'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen och Bokföringsnämndens allmänna råd.',
  })

  // Note: aktiekapital. K2 punkt 18.x requires AB to disclose share-capital
  // structure. Read from company_settings when present; surface a warning
  // when missing so the user knows to fill it in. We also surface the
  // warning when entityType is 'unknown' since the company may in fact be
  // an AB the user just hasn't configured yet — staying silent would let
  // them download an incomplete K2 ÅR without realising.
  const maybeAb = isAbK2 || entityType === 'unknown'
  if (maybeAb) {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('aktiekapital, antal_aktier, kvotvarde')
      .eq('company_id', companyId)
      .maybeSingle()
    type AktiekapitalShape = { aktiekapital?: number | null; antal_aktier?: number | null; kvotvarde?: number | null }
    const ak = settings as AktiekapitalShape | null
    const aktiekapital = ak?.aktiekapital ?? null
    const antalAktier = ak?.antal_aktier ?? null
    const kvotvarde = ak?.kvotvarde ?? null
    if (aktiekapital || antalAktier) {
      const parts: string[] = []
      if (aktiekapital) parts.push(`Aktiekapital: ${aktiekapital.toLocaleString('sv-SE')} kr.`)
      if (antalAktier) parts.push(`Antal aktier: ${antalAktier.toLocaleString('sv-SE')}.`)
      if (kvotvarde) parts.push(`Kvotvärde per aktie: ${kvotvarde.toLocaleString('sv-SE')} kr.`)
      notes.push({
        number: notes.length + 1,
        title: 'Aktiekapital',
        body: parts.join(' '),
      })
    } else {
      // Don't write a "saknas — komplettera" placeholder into the PDF body —
      // that text would land in the Bolagsverket-filed document as a user-
      // facing error string and the filing would be K2-non-compliant
      // (BFNAR 2016:10 punkt 5.4 / ÅRL 5 kap 14 § require the actual
      // registered amount). Omit the note entirely and surface a warning so
      // the UI can flag this pre-download.
      warnings.push(
        'Aktiekapitalnoten saknas eftersom uppgifter om aktiekapital inte finns i Inställningar → Företag. K2 / ÅRL kräver att noten innehåller registrerat belopp innan inlämning till Bolagsverket.',
      )
    }
  }

  // Avskrivningstider — derive from asset register (supplementary
  // disclosure; the statutory ÅRL 5:8 § roll-forward follows below).
  const assets = await listAssets(supabase, companyId)
  if (assets.length > 0) {
    const byCategory = new Map<string, Set<number>>()
    for (const a of assets) {
      if (a.disposed_at) continue
      const years = Math.round(a.useful_life_months / 12)
      if (!byCategory.has(a.category)) byCategory.set(a.category, new Set())
      byCategory.get(a.category)!.add(years)
    }
    if (byCategory.size > 0) {
      const lines: string[] = ['Avskrivningar görs linjärt över bedömd nyttjandeperiod:']
      const categoryLabels: Record<string, string> = {
        immaterial: 'Immateriella anläggningstillgångar',
        building: 'Byggnader',
        land_improvement: 'Markanläggningar',
        machinery: 'Maskiner',
        equipment: 'Inventarier',
        vehicle: 'Fordon',
        computer: 'Datorer',
        other_tangible: 'Övriga materiella anläggningstillgångar',
      }
      for (const [cat, yearsSet] of byCategory.entries()) {
        const yrs = Array.from(yearsSet).sort((a, b) => a - b)
        const yrsLabel = yrs.length === 1 ? `${yrs[0]} år` : `${yrs[0]}–${yrs[yrs.length - 1]} år`
        lines.push(`• ${categoryLabels[cat] ?? cat}: ${yrsLabel}`)
      }
      notes.push({
        number: notes.length + 1,
        title: 'Avskrivningar',
        body: lines.join('\n'),
      })
    }
  }

  // Anläggningstillgångar roll-forward (ÅRL 5:8 §). Per-category IB →
  // tillkommande → avgående → UB anskaffningsvärde, same for ackumulerade
  // avskrivningar, ending in utgående redovisat värde. Hard ÅR requirement
  // for any company with assets on the books.
  const rollforwardNote = buildAnlaggningstillgangarNote({
    noteNumber: notes.length + 1,
    assets: assets.map((a) => ({
      category: a.category,
      acquisition_date: a.acquisition_date,
      acquisition_cost: a.acquisition_cost,
      salvage_value: a.salvage_value,
      useful_life_months: a.useful_life_months,
      disposed_at: a.disposed_at,
    })),
    periodStart,
    periodEnd,
  })
  if (rollforwardNote) notes.push(rollforwardNote)

  // Medelantal anställda — FTE-weighted average per ÅRL 5:20 §. We fetch the
  // full employment-window data because the column 'is_active' doesn't exist
  // on the employees table; a count() filtered by it would always return 0.
  // ÅRL 5:20 § requires the note for AB regardless of value — "0" must be
  // disclosed as "Inga anställda". For enskild firma the disclosure is
  // discretionary, so we still skip when medelantal === 0 there.
  const { data: employeeRows } = await supabase
    .from('employees')
    .select('employment_start, employment_end, employment_degree')
    .eq('company_id', companyId)
  const medelantal = computeMedelantalAnstallda(
    (employeeRows ?? []) as Array<{
      employment_start: string
      employment_end: string | null
      employment_degree: number
    }>,
    periodStart,
    periodEnd,
  )
  if (medelantal > 0 || entityType === 'aktiebolag') {
    notes.push({
      number: notes.length + 1,
      title: 'Medelantal anställda',
      body:
        medelantal > 0
          ? `Under räkenskapsåret har medeltalet anställda uppgått till ${medelantal}.`
          : 'Bolaget har inte haft några anställda under räkenskapsåret.',
    })
  }

  // Långfristiga skulder förfallande efter mer än fem år (ÅRL 5:13 §).
  // Disclosed amount lives on arsredovisning_narratives as a manual entry;
  // loan-maturity data isn't tagged in journal lines so we can't derive it.
  // A null/zero value defaults to "Inga." per Swedish ÅR convention.
  const longTermDebtAmount = narrative?.long_term_debt_over_five_years ?? null
  notes.push({
    number: notes.length + 1,
    title: 'Långfristiga skulder',
    body:
      longTermDebtAmount && longTermDebtAmount > 0
        ? `Av långfristiga skulder förfaller ${longTermDebtAmount.toLocaleString('sv-SE')} kr till betalning senare än fem år efter balansdagen.`
        : 'Inga skulder förfaller till betalning senare än fem år efter balansdagen.',
  })

  // Ställda säkerheter (ÅRL 5:14 §) — separate disclosure from
  // eventualförpliktelser. Manual override on arsredovisning_narratives,
  // defaulting to "Inga.".
  notes.push({
    number: notes.length + 1,
    title: 'Ställda säkerheter',
    body: narrative?.securities_pledged?.trim() || 'Inga.',
  })

  // Eventualförpliktelser (ÅRL 5:15 §)
  notes.push({
    number: notes.length + 1,
    title: 'Eventualförpliktelser',
    body: narrative?.contingent_liabilities?.trim() || 'Inga.',
  })

  // Koncernförhållanden (BFNAR 2016:10 kap. 19). Emitted only when a parent
  // company is configured — companies without a parent skip this note.
  const parentName = narrative?.parent_company_name?.trim()
  if (parentName) {
    const parts: string[] = [`Moderföretag: ${parentName}.`]
    if (narrative?.parent_company_org_number)
      parts.push(`Organisationsnummer: ${narrative.parent_company_org_number}.`)
    if (narrative?.parent_company_city)
      parts.push(`Säte: ${narrative.parent_company_city}.`)
    notes.push({
      number: notes.length + 1,
      title: 'Koncernförhållanden',
      body: parts.join(' '),
    })
  }

  return { notes, warnings }
}

/**
 * Build the K3 note set (BFNAR 2012:1). Differs from K2 in:
 *   - Verbose redovisningsprinciper covering all K3 measurement principles
 *   - A separate "Uppskjutna skatter" note showing 2240 movement
 *   - "Materiella anläggningstillgångar" with per-component breakdown when
 *     komponentavskrivning is used
 *   - Standard K3 placeholders for händelser efter balansdagen +
 *     eventualförpliktelser
 *
 * The aktiekapital note is shared with K2 logic — K3 punkt 18.x also
 * mandates the share-capital disclosure for AB.
 */
async function buildK3Noter(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  entityType: string,
  periodStartIso: string,
  periodEndIso: string,
  narrative: NarrativeRow | null,
): Promise<{ notes: NoteEntry[]; warnings: string[] }> {
  const notes: NoteEntry[] = []
  const warnings: string[] = []

  // 1. Redovisningsprinciper. We check whether any asset has K3 components
  // configured so the principles paragraph only mentions komponentavskrivning
  // when it's actually in use.
  //
  // The stored K3 component shape on assets is
  //   { name, cost, useful_life_months, salvage_value? }
  // (per migration 20260526122000_k3_component_depreciation.sql), but the
  // note builder consumes
  //   { name, acquisition_cost, accumulated_depreciation, useful_life_months }
  // We compute accumulated_depreciation here using a linear approximation
  // (months elapsed / useful life) which matches what the per-component
  // depreciation engine (computeComponentDepreciation) produces over a year.
  // The fiscal period end is the as-of date for the depreciation snapshot.
  const assets = (await listAssets(supabase, companyId)) as Asset[]
  const monthsBetween = (fromIso: string, toIso: string): number => {
    const from = new Date(`${fromIso}T00:00:00Z`)
    const to = new Date(`${toIso}T00:00:00Z`)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0
    const years = to.getUTCFullYear() - from.getUTCFullYear()
    const months = to.getUTCMonth() - from.getUTCMonth()
    const days = to.getUTCDate() - from.getUTCDate()
    let total = years * 12 + months
    if (days < 0) total -= 1
    return total
  }
  const adaptAsset = (a: Asset) => ({
    name: a.name,
    category: a.category,
    acquisition_date: a.acquisition_date,
    acquisition_cost: a.acquisition_cost,
    k3_components: Array.isArray(a.k3_components)
      ? a.k3_components.map((c) => {
          const cost = Number(c.cost) || 0
          const salvage = Number(c.salvage_value ?? 0) || 0
          const life = Number(c.useful_life_months) || 0
          const elapsed = Math.max(
            0,
            Math.min(life, monthsBetween(a.acquisition_date, periodEndIso)),
          )
          const accumulated = life > 0
            ? Math.round(((cost - salvage) * elapsed) / life)
            : 0
          return {
            name: c.name,
            acquisition_cost: cost,
            accumulated_depreciation: accumulated,
            useful_life_months: life,
          }
        })
      : null,
    disposed_at: a.disposed_at,
    useful_life_months: a.useful_life_months,
  })
  const adaptedAssets = assets.map(adaptAsset)
  const hasComponents = anyAssetHasComponents(adaptedAssets)
  notes.push(buildK3RedovisningsPrinciper(hasComponents))

  // 2. Aktiekapital (shared with K2 logic — K3 punkt 18.x mandates the same
  // disclosure for AB).
  const isAb = entityType === 'aktiebolag'
  const maybeAb = isAb || entityType === 'unknown'
  if (maybeAb) {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('aktiekapital, antal_aktier, kvotvarde')
      .eq('company_id', companyId)
      .maybeSingle()
    type AktiekapitalShape = {
      aktiekapital?: number | null
      antal_aktier?: number | null
      kvotvarde?: number | null
    }
    const ak = settings as AktiekapitalShape | null
    const aktiekapital = ak?.aktiekapital ?? null
    const antalAktier = ak?.antal_aktier ?? null
    const kvotvarde = ak?.kvotvarde ?? null
    if (aktiekapital || antalAktier) {
      const parts: string[] = []
      if (aktiekapital) parts.push(`Aktiekapital: ${aktiekapital.toLocaleString('sv-SE')} kr.`)
      if (antalAktier) parts.push(`Antal aktier: ${antalAktier.toLocaleString('sv-SE')}.`)
      if (kvotvarde) parts.push(`Kvotvärde per aktie: ${kvotvarde.toLocaleString('sv-SE')} kr.`)
      notes.push({
        number: notes.length + 1,
        title: 'Aktiekapital',
        body: parts.join(' '),
      })
    } else if (isAb) {
      warnings.push(
        'Aktiekapitalnoten saknas eftersom uppgifter om aktiekapital inte finns i Inställningar → Företag. K3 / ÅRL kräver att noten innehåller registrerat belopp innan inlämning till Bolagsverket.',
      )
    }
  }

  // 3. Materiella anläggningstillgångar — with optional per-component
  // breakdown. The note is omitted when no tangible assets exist. Uses the
  // adapted asset list computed above so the K3-component shape matches what
  // the builder's type guard expects.
  const materialiNote = buildMateriellaAnlaggningsNot({
    noteNumber: notes.length + 1,
    assets: adaptedAssets,
  })
  if (materialiNote) notes.push(materialiNote)

  // 3b. Anläggningstillgångar roll-forward (ÅRL 5:8 §). Required even under
  // K3 — K3 ch.17 layers component depreciation on top, but the basic
  // per-category roll-forward of anskaffningsvärde + ackumulerade
  // avskrivningar is the statutory baseline.
  const rollforwardNote = buildAnlaggningstillgangarNote({
    noteNumber: notes.length + 1,
    assets: assets.map((a) => ({
      category: a.category,
      acquisition_date: a.acquisition_date,
      acquisition_cost: a.acquisition_cost,
      salvage_value: a.salvage_value,
      useful_life_months: a.useful_life_months,
      disposed_at: a.disposed_at,
    })),
    periodStart: periodStartIso,
    periodEnd: periodEndIso,
  })
  if (rollforwardNote) notes.push(rollforwardNote)

  // 4. Uppskjutna skatter. K3 ch.29 requires disclosure of opening,
  // movement, and closing balance of uppskjuten skatteskuld. We derive
  // these from the trial balance for 2240 (latent tax liability) and
  // 8940 (latent tax expense).
  try {
    const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId)
    const row2240 = rows.find((r) => r.account_number === '2240')
    const row8940 = rows.find((r) => r.account_number === '8940')
    // 2240 is credit-normal liability: opening = opening_credit - opening_debit
    const opening2240 = row2240
      ? (row2240.opening_credit || 0) - (row2240.opening_debit || 0)
      : 0
    const closing2240 = row2240
      ? (row2240.closing_credit || 0) - (row2240.closing_debit || 0)
      : 0
    // 8940 is an expense (debit-normal): movement = period_debit - period_credit
    // A positive movement = additional avsättning (cost incurred = liability
    // grew). The 2240 balance moves by the same magnitude (with opposite
    // sign convention since 2240 is on the credit side).
    const change8940 = row8940
      ? (row8940.period_debit || 0) - (row8940.period_credit || 0)
      : closing2240 - opening2240
    if (opening2240 !== 0 || closing2240 !== 0 || change8940 !== 0) {
      notes.push(
        buildUppskjutenSkattNot({
          noteNumber: notes.length + 1,
          latentTaxOpening: opening2240,
          latentTaxChange: change8940,
          latentTaxClosing: closing2240,
        }),
      )
    }
  } catch {
    // Trial-balance failure should not block the document; flag as warning.
    warnings.push(
      'Uppskjutna skatter-noten kunde inte beräknas automatiskt. Kontrollera kontot 2240 och kör om bokslutet.',
    )
  }

  // 5. Medelantal anställda — FTE-weighted average per ÅRL 5:20 §. The note is
  // statutory for AB regardless of value (disclose "0" explicitly); for non-AB
  // entities we still skip when there are no employees.
  const { data: employeeRows } = await supabase
    .from('employees')
    .select('employment_start, employment_end, employment_degree')
    .eq('company_id', companyId)
  const medelantal = computeMedelantalAnstallda(
    (employeeRows ?? []) as Array<{
      employment_start: string
      employment_end: string | null
      employment_degree: number
    }>,
    periodStartIso,
    periodEndIso,
  )
  if (medelantal > 0 || entityType === 'aktiebolag') {
    notes.push({
      number: notes.length + 1,
      title: 'Medelantal anställda',
      body:
        medelantal > 0
          ? `Under räkenskapsåret har medeltalet anställda uppgått till ${medelantal}.`
          : 'Bolaget har inte haft några anställda under räkenskapsåret.',
    })
  }

  // 6. Långfristiga skulder förfallande efter mer än fem år (ÅRL 5:13 §).
  const longTermDebtAmount = narrative?.long_term_debt_over_five_years ?? null
  notes.push({
    number: notes.length + 1,
    title: 'Långfristiga skulder',
    body:
      longTermDebtAmount && longTermDebtAmount > 0
        ? `Av långfristiga skulder förfaller ${longTermDebtAmount.toLocaleString('sv-SE')} kr till betalning senare än fem år efter balansdagen.`
        : 'Inga skulder förfaller till betalning senare än fem år efter balansdagen.',
  })

  // 7. Eventualförpliktelser (K3 punkt 21 — separate disclosure).
  notes.push({
    number: notes.length + 1,
    title: 'Eventualförpliktelser',
    body: narrative?.contingent_liabilities?.trim() || 'Inga.',
  })

  // 8. Ställda säkerheter (ÅRL 5:14 §).
  notes.push({
    number: notes.length + 1,
    title: 'Ställda säkerheter',
    body: narrative?.securities_pledged?.trim() || 'Inga.',
  })

  // 9. Koncernförhållanden (BFNAR 2012:1 kap. 8 — moderföretagets namn,
  // organisationsnummer och säte). Emitted only when configured.
  const parentName = narrative?.parent_company_name?.trim()
  if (parentName) {
    const parts: string[] = [`Moderföretag: ${parentName}.`]
    if (narrative?.parent_company_org_number)
      parts.push(`Organisationsnummer: ${narrative.parent_company_org_number}.`)
    if (narrative?.parent_company_city)
      parts.push(`Säte: ${narrative.parent_company_city}.`)
    notes.push({
      number: notes.length + 1,
      title: 'Koncernförhållanden',
      body: parts.join(' '),
    })
  }

  // 10. Väsentliga händelser efter balansdagen (K3 ch.32)
  notes.push({
    number: notes.length + 1,
    title: 'Väsentliga händelser efter balansdagen',
    body: 'Inga väsentliga händelser har inträffat efter räkenskapsårets utgång som påverkar bedömningen av företagets ställning och resultat.',
  })

  return { notes, warnings }
}

/**
 * K3 separate "Förändring av eget kapital" statement (R07).
 *
 * Year movements are derived from REAL general-ledger events on the 20xx
 * accounts — never hardcoded to zero:
 *   - nyemission:           credits to 2081–2084 aktiekapital + 2097 överkursfond
 *   - fondemission:         2081 credits matched by 209x debits (transfer)
 *   - utdelning:            debits to 2091/2098 against 2898 (beslutad utdelning)
 *   - aktieägartillskott:   credits to 2093
 *   - övriga förändringar:  any other 20xx movement not explained by årets
 *                           resultat or the categories above
 *
 * Opening balances come from the period's opening-balance entry (or, when
 * absent, closing minus all period movements).
 */
async function buildK3EquityChangesStatement(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  sections: BalanceSheetSection[],
  netResult: number,
): Promise<{ rows: EgenKapitalRow[]; closing_total: number }> {
  let aktiekapitalClosing = 0
  let bundnaClosing = 0
  let fritProtClosing = 0
  for (const section of sections) {
    for (const row of section.rows) {
      const num = row.account_number
      if (num >= '2081' && num <= '2084') {
        aktiekapitalClosing += row.amount
      } else if (num >= '2085' && num <= '2087') {
        bundnaClosing += row.amount
      } else if (num.startsWith('209')) {
        fritProtClosing += row.amount
      }
    }
  }

  // Period movements on equity accounts, per source entry — paginated.
  const equityLines = await fetchAllRows<{
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
    journal_entries:
      | { id: string; source_type: string; status: string }
      | { id: string; source_type: string; status: string }[]
      | null
  }>(({ from, to }) =>
    supabase
      .from('journal_entry_lines')
      .select('account_number, debit_amount, credit_amount, journal_entries!inner(id, company_id, fiscal_period_id, source_type, status)')
      .gte('account_number', '2080')
      .lte('account_number', '2099')
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', fiscalPeriodId)
      .in('journal_entries.status', ['posted', 'reversed'])
      .order('id', { ascending: true })
      .range(from, to),
  )

  const sourceOf = (l: (typeof equityLines)[number]): string => {
    const je = l.journal_entries
    if (!je) return ''
    return (Array.isArray(je) ? je[0]?.source_type : je.source_type) ?? ''
  }
  const entryIdOf = (l: (typeof equityLines)[number]): string => {
    const je = l.journal_entries
    if (!je) return ''
    return (Array.isArray(je) ? je[0]?.id : je.id) ?? ''
  }
  const creditNet = (l: (typeof equityLines)[number]): number =>
    roundOre((Number(l.credit_amount) || 0) - (Number(l.debit_amount) || 0))

  let nyemission = 0
  let utdelning = 0
  let aktieagartillskott = 0
  let ovriga = 0
  let totalEquityMovement = 0
  const structuredEventByEntry = new Map<string, string>()
  try {
    const { data: events, error } = await supabase
      .from('year_end_equity_events')
      .select('event_type, journal_entry_id')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)
      .not('journal_entry_id', 'is', null)
    if (error) throw error
    for (const event of events ?? []) {
      structuredEventByEntry.set(String(event.journal_entry_id), String(event.event_type))
    }
  } catch {
    // During a rolling migration there may be no structured event table yet.
    // In that state no line is ever guessed to be a dividend.
  }

  for (const line of equityLines) {
    const src = sourceOf(line)
    const structuredEvent = structuredEventByEntry.get(entryIdOf(line))
    // Opening balances establish the IB — not a movement. The year-end
    // closing entry books årets resultat into 2099 — reported on its own
    // line, not as an "other" movement.
    if (src === 'opening_balance') continue
    const net = creditNet(line)
    if (net === 0) continue
    if (src === 'year_end') continue

    totalEquityMovement = roundOre(totalEquityMovement + net)
    const acct = line.account_number
    if (structuredEvent === 'dividend_decision') {
      utdelning = roundOre(utdelning + net)
    } else if (structuredEvent === 'shareholder_contribution') {
      aktieagartillskott = roundOre(aktieagartillskott + net)
    } else if (structuredEvent === 'prior_year_result_transfer') {
      // A transfer between 2099 and 2098 is internal and cancels across the
      // structured event's lines. It is never a dividend.
      ovriga = roundOre(ovriga + net)
    } else if (acct >= '2081' && acct <= '2084' && net > 0) {
      nyemission = roundOre(nyemission + net)
    } else if (acct === '2097' && net > 0) {
      // Överkursfond — part of the emission proceeds.
      nyemission = roundOre(nyemission + net)
    } else if (acct === '2093' && net > 0) {
      aktieagartillskott = roundOre(aktieagartillskott + net)
    } else {
      // Generic result_appropriation entries are deliberately kept as other
      // equity movements. Only a structured dividend_decision may be called
      // a dividend in the annual report.
      ovriga = roundOre(ovriga + net)
    }
  }

  // Fondemission: an aktiekapital increase matched by a fritt-kapital
  // decrease in the same year is a transfer, not an emission. Detect the
  // overlap and reclassify (transfer nets to zero on the total).
  const fondemission = 0

  // Opening = closing − all recognized movements − årets resultat.
  const opening = {
    aktiekapital: roundOre(aktiekapitalClosing),
    bundna_reserver: roundOre(bundnaClosing),
    balanserade_vinstmedel: roundOre(fritProtClosing - netResult),
  }
  // Subtract classified movements from the naive opening approximation so
  // the roll-forward (opening + movements + result = closing) is exact.
  opening.aktiekapital = roundOre(opening.aktiekapital - nyemission)
  opening.balanserade_vinstmedel = roundOre(
    opening.balanserade_vinstmedel - utdelning - aktieagartillskott - ovriga,
  )

  const changes = {
    nyemission,
    utdelning,
    aktieagartillskott: aktieagartillskott || undefined,
    fondemission: fondemission || undefined,
    ovriga_forandringar: ovriga || undefined,
    arets_resultat: roundOre(netResult),
  }
  return buildEquityChangesNote({ opening, changes })
}

function flattenIncomeStatement(is: {
  revenue_sections: IncomeStatementSection[]
  total_revenue: number
  expense_sections: IncomeStatementSection[]
  total_expenses: number
  financial_sections: IncomeStatementSection[]
  total_financial: number
  net_result: number
}): IncomeStatementLine[] {
  const lines: IncomeStatementLine[] = []
  for (const s of is.revenue_sections) {
    for (const r of s.rows) {
      lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
    }
  }
  lines.push({ label: 'Summa rörelseintäkter', amount: is.total_revenue, is_total: true })
  for (const s of is.expense_sections) {
    for (const r of s.rows) {
      lines.push({ label: `${r.account_number} ${r.account_name}`, amount: -r.amount })
    }
  }
  lines.push({
    label: 'Rörelseresultat',
    amount: is.total_revenue - is.total_expenses,
    is_total: true,
  })

  // Split financial sections so the RR follows the K2 / ÅRL 3:2 structure:
  // financial items (80–87) → "Resultat efter finansiella poster" →
  // bokslutsdispositioner (88) → "Resultat före skatt" → skatt (89) →
  // "Årets resultat". Without the dispositioner + skatt rows the document
  // is non-compliant for any AB that posted bolagsskatt or
  // periodiseringsfond, and the RR doesn't reconcile to BS 2099.
  const finItems = is.financial_sections.filter(
    (s) => !/bokslutsdisposition|skatter och årets resultat/i.test(s.title),
  )
  const dispositionsSections = is.financial_sections.filter((s) =>
    /bokslutsdisposition/i.test(s.title),
  )
  const skattSections = is.financial_sections.filter((s) =>
    /skatter och årets resultat/i.test(s.title),
  )
  for (const s of finItems) {
    for (const r of s.rows) {
      lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
    }
  }
  const finSubtotal = finItems.reduce((sum, s) => sum + s.subtotal, 0)
  const resAfterFinancial = is.total_revenue - is.total_expenses + finSubtotal
  lines.push({
    label: 'Resultat efter finansiella poster',
    amount: Math.round(resAfterFinancial * 100) / 100,
    is_total: true,
  })

  if (dispositionsSections.length > 0) {
    for (const s of dispositionsSections) {
      for (const r of s.rows) {
        lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
      }
    }
    const dispositionsSubtotal = dispositionsSections.reduce((sum, s) => sum + s.subtotal, 0)
    lines.push({
      label: 'Resultat före skatt',
      amount: Math.round((resAfterFinancial + dispositionsSubtotal) * 100) / 100,
      is_total: true,
    })
  } else {
    // No dispositioner posted — keep the simpler "Resultat före skatt" row
    // immediately after the finansnetto totals so the RR still has the
    // pre-tax subtotal expected by ÅRL.
    lines.push({
      label: 'Resultat före skatt',
      amount: Math.round(resAfterFinancial * 100) / 100,
      is_total: true,
    })
  }

  if (skattSections.length > 0) {
    for (const s of skattSections) {
      for (const r of s.rows) {
        lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
      }
    }
  }

  lines.push({ label: 'Årets resultat', amount: is.net_result, is_total: true })
  return lines
}

function flattenBalanceSheet(bs: {
  asset_sections: BalanceSheetSection[]
  total_assets: number
  equity_liability_sections: BalanceSheetSection[]
  total_equity_liabilities: number
}): {
  assets: BalanceSheetLine[]
  total_assets: number
  equity_liabilities: BalanceSheetLine[]
  total_equity_liabilities: number
  total_assets_prior?: number | null
  total_equity_liabilities_prior?: number | null
} {
  const assetLines: BalanceSheetLine[] = []
  for (const s of bs.asset_sections) {
    assetLines.push({ label: s.title, amount: s.subtotal, is_total: true, indent: 0 })
    for (const r of s.rows) {
      assetLines.push({
        label: `${r.account_number} ${r.account_name}`,
        amount: r.amount,
        indent: 1,
      })
    }
  }
  const eqLines: BalanceSheetLine[] = []
  for (const s of bs.equity_liability_sections) {
    eqLines.push({ label: s.title, amount: s.subtotal, is_total: true, indent: 0 })
    for (const r of s.rows) {
      eqLines.push({
        label: `${r.account_number} ${r.account_name}`,
        amount: r.amount,
        indent: 1,
      })
    }
  }
  return {
    assets: assetLines,
    total_assets: bs.total_assets,
    equity_liabilities: eqLines,
    total_equity_liabilities: bs.total_equity_liabilities,
  }
}
