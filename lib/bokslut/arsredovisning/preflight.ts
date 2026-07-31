import type { ArsredovisningData } from './types'
import { containsForbiddenAnnualReportCharacters } from './format'

export type AnnualReportIssueScope = 'ledger' | 'annual_report' | 'presentation' | 'archive'
export type AnnualReportIssueSeverity = 'blocking' | 'warning'

export interface AnnualReportIssueAction {
  id: string
  label: string
}

export interface AnnualReportPreflightIssue {
  code: string
  severity: AnnualReportIssueSeverity
  scope: AnnualReportIssueScope
  message: string
  compared_values?: Record<string, string | number | boolean | null>
  requires_reopen: boolean
  actions: AnnualReportIssueAction[]
}

export interface AnnualReportPreflightReport {
  preflight_status: 'passed' | 'failed'
  blocking_issue_count: number
  warning_count: number
  issues: AnnualReportPreflightIssue[]
}

export interface AnnualReportPreflightState {
  ledger_locked: boolean
  period_closed: boolean
  closing_entry_id: string | null
  annual_report_locked?: boolean
  pdf_ixbrl_match?: boolean | null
  pdf_text_contains_draft?: boolean | null
  final_pdf_requested?: boolean
}

function issue(
  code: string,
  severity: AnnualReportIssueSeverity,
  scope: AnnualReportIssueScope,
  message: string,
  actions: AnnualReportIssueAction[],
  options: {
    requiresReopen?: boolean
    comparedValues?: AnnualReportPreflightIssue['compared_values']
  } = {},
): AnnualReportPreflightIssue {
  return {
    code,
    severity,
    scope,
    message,
    compared_values: options.comparedValues,
    requires_reopen: options.requiresReopen ?? false,
    actions,
  }
}

export function runAnnualReportPreflight(
  data: ArsredovisningData,
  state: AnnualReportPreflightState,
): AnnualReportPreflightReport {
  const issues: AnnualReportPreflightIssue[] = []
  const add = (value: AnnualReportPreflightIssue) => issues.push(value)

  const legalName = data.company.name.trim()
  const registeredOffice = data.company.city?.trim() ?? ''
  if (!legalName || legalName === 'Bolaget') {
    add(
      issue(
        'LEGAL_NAME_MISSING',
        'blocking',
        'annual_report',
        'Juridiskt företagsnamn saknas i årsredovisningen.',
        [{ id: 'edit_narrative', label: 'Ange juridiskt företagsnamn' }],
      ),
    )
  }
  if (!/^\d{6}-\d{4}$/.test(data.company.org_number.trim())) {
    add(
      issue(
        'ORGANISATION_NUMBER_INVALID',
        'blocking',
        'annual_report',
        'Organisationsnumret saknas eller har ogiltigt format.',
        [{ id: 'edit_narrative', label: 'Kontrollera företagsuppgifterna' }],
        { comparedValues: { organisation_number: data.company.org_number } },
      ),
    )
  }
  if (!registeredOffice) {
    add(
      issue(
        'REGISTERED_OFFICE_MISSING',
        'blocking',
        'annual_report',
        'Bolagets säte saknas i årsredovisningen.',
        [{ id: 'edit_narrative', label: 'Ange säte' }],
      ),
    )
  }

  if (!state.period_closed || !state.ledger_locked || !state.closing_entry_id) {
    add(
      issue(
        'LEDGER_NOT_LOCKED',
        'blocking',
        'ledger',
        'Räkenskapsåret är inte fullständigt stängt med en spårbar bokslutsverifikation.',
        [{ id: 'open_year_end', label: 'Öppna bokslutskontrollen' }],
        {
          comparedValues: {
            period_closed: state.period_closed,
            ledger_locked: state.ledger_locked,
            closing_entry_id: state.closing_entry_id,
          },
        },
      ),
    )
  }

  const balanceDifference =
    Math.round((data.balansrakning.total_assets - data.balansrakning.total_equity_liabilities) * 100) / 100
  if (balanceDifference !== 0) {
    add(
      issue(
        'BALANCE_SHEET_NOT_BALANCED',
        'blocking',
        'ledger',
        'Balansräkningen balanserar inte i exakta belopp.',
        [
          { id: 'show_balance_analysis', label: 'Visa balansanalys' },
          { id: 'request_reopen', label: 'Återöppna året för rättelse' },
        ],
        {
          requiresReopen: true,
          comparedValues: {
            total_assets: data.balansrakning.total_assets,
            total_equity_liabilities: data.balansrakning.total_equity_liabilities,
            difference: balanceDifference,
          },
        },
      ),
    )
  }

  const roundedAssets = Math.round(data.balansrakning.total_assets)
  const roundedEquityLiabilities = Math.round(data.balansrakning.total_equity_liabilities)
  if (roundedAssets !== roundedEquityLiabilities) {
    add(
      issue(
        'PRESENTED_BALANCE_NOT_BALANCED',
        'blocking',
        'presentation',
        'Balansräkningen balanserar inte efter presentation i hela kronor.',
        [{ id: 'show_rounding_analysis', label: 'Visa avrundningsanalys' }],
        {
          comparedValues: {
            rounded_assets: roundedAssets,
            rounded_equity_liabilities: roundedEquityLiabilities,
          },
        },
      ),
    )
  }

  const assetGrandTotals = data.balansrakning.assets.filter(
    (line) => line.label === 'Summa tillgångar',
  ).length
  const eqGrandTotals = data.balansrakning.equity_liabilities.filter(
    (line) => line.label === 'Summa eget kapital och skulder',
  ).length
  if (assetGrandTotals > 0 || eqGrandTotals > 0) {
    add(
      issue(
        'DUPLICATE_BALANCE_TOTAL_ROWS',
        'blocking',
        'presentation',
        'Balansens grand total finns både i radmodellen och i slutsumman.',
        [{ id: 'regenerate_report', label: 'Generera om rapporten' }],
        { comparedValues: { asset_rows: assetGrandTotals, equity_liability_rows: eqGrandTotals } },
      ),
    )
  }

  if (data.prior_period && !data.prior_period.source_type) {
    add(
      issue(
        'COMPARATIVES_NOT_VERIFIED',
        'blocking',
        'annual_report',
        `Jämförelsetal ${data.prior_period.name} saknar verifierad källa.`,
        [
          { id: 'import_prior_annual_report', label: 'Importera fastställd årsredovisning' },
          { id: 'enter_verified_comparatives', label: 'Registrera verifierade jämförelsetal' },
        ],
      ),
    )
  }

  if (data.forvaltningsberattelse.flerarsoversikt.some((row) => row.data_missing)) {
    add(
      issue(
        'MULTI_YEAR_DATA_MISSING',
        'blocking',
        'annual_report',
        'Flerårsöversikten innehåller år utan verifierat underlag.',
        [{ id: 'complete_multi_year_overview', label: 'Komplettera flerårsöversikten' }],
      ),
    )
  }

  if (data.unconfirmed_defaults.length > 0) {
    add(
      issue(
        'NARRATIVE_NOT_CONFIRMED',
        'blocking',
        'annual_report',
        `Dokumenttexter är inte verifierade: ${data.unconfirmed_defaults.join(', ')}.`,
        [{ id: 'edit_narrative', label: 'Granska dokumenttexter' }],
      ),
    )
  }

  const signaturesMissing = data.signatures.filter(
    (signature) => signature.status !== 'signed' || !signature.signed_at,
  )
  if (data.signatures.length === 0 || signaturesMissing.length > 0) {
    add(
      issue(
        'SIGNATURES_INCOMPLETE',
        'blocking',
        'annual_report',
        'Samtliga obligatoriska undertecknare och verkliga underskriftsdatum måste finnas.',
        [{ id: 'manage_signatures', label: 'Hantera undertecknare' }],
        { comparedValues: { total: data.signatures.length, incomplete: signaturesMissing.length } },
      ),
    )
  }
  for (const signature of data.signatures) {
    const signedDate = signature.signed_at?.slice(0, 10) ?? null
    if (signedDate && signedDate <= data.fiscal_period.period_end) {
      add(
        issue(
          'SIGNATURE_DATE_NOT_AFTER_BALANCE_DATE',
          'blocking',
          'annual_report',
          `${signature.name} har ett underskriftsdatum som inte ligger efter balansdagen.`,
          [{ id: 'manage_signatures', label: 'Rätta underskriftsdatum' }],
          {
            comparedValues: {
              signer: signature.name,
              signed_date: signedDate,
              balance_date: data.fiscal_period.period_end,
            },
          },
        ),
      )
    }
  }

  const fb = data.forvaltningsberattelse
  if (!fb.agm_date || fb.agm_accounts_adopted !== true) {
    add(
      issue(
        'AGM_ADOPTION_INCOMPLETE',
        'blocking',
        'annual_report',
        'Årsstämmodatum och bekräftelse att resultat- och balansräkningen fastställts saknas.',
        [{ id: 'complete_agm', label: 'Komplettera årsstämman' }],
      ),
    )
  }
  if (!fb.agm_result_disposition_decision?.trim()) {
    add(
      issue(
        'AGM_RESULT_DECISION_MISSING',
        'blocking',
        'annual_report',
        'Årsstämmans beslut om resultatdisposition saknas och får inte ersättas av styrelsens förslag.',
        [{ id: 'complete_agm', label: 'Ange stämmans beslut' }],
      ),
    )
  }
  if (
    !fb.certificate_signer_name?.trim() ||
    !fb.certificate_signer_role?.trim() ||
    !fb.certificate_signed_at
  ) {
    add(
      issue(
        'CERTIFICATE_SIGNATURE_MISSING',
        'blocking',
        'annual_report',
        'Fastställelseintygets undertecknare, roll eller verkliga signeringsdatum saknas.',
        [{ id: 'complete_certificate', label: 'Komplettera fastställelseintyget' }],
      ),
    )
  }

  const latestOverview = data.forvaltningsberattelse.flerarsoversikt.at(-1)
  const formalResultAfterFinancial = data.formal_report?.totals.resultatEfterFinansiellaPoster.current
  if (
    latestOverview &&
    formalResultAfterFinancial != null &&
    Math.round(latestOverview.result_after_financial) !== Math.round(formalResultAfterFinancial)
  ) {
    add(
      issue(
        'MULTI_YEAR_RESULT_METRIC_DRIFT',
        'blocking',
        'presentation',
        'Flerårsöversikten använder inte samma resultat efter finansiella poster som resultaträkningen.',
        [{ id: 'regenerate_report', label: 'Generera om rapporten' }],
        {
          comparedValues: {
            overview: latestOverview.result_after_financial,
            income_statement: formalResultAfterFinancial,
          },
        },
      ),
    )
  }

  if (
    data.forvaltningsberattelse.egen_kapital_changes.some((row) =>
      /manuell granskning|ej klassificerad/i.test(row.label),
    )
  ) {
    add(
      issue(
        'EQUITY_ROLLFORWARD_UNEXPLAINED',
        'blocking',
        'annual_report',
        'Förändringen av eget kapital innehåller en ej klassificerad rörelse.',
        [{ id: 'review_equity', label: 'Granska eget kapital' }],
      ),
    )
  }

  for (const overviewRow of fb.flerarsoversikt) {
    if (overviewRow.soliditet_pct !== null && overviewRow.soliditet_pct > 100) {
      add(
        issue(
          'SOLIDITY_OVER_100',
          'warning',
          'presentation',
          `Soliditeten för ${overviewRow.year} överstiger 100 %.`,
          [
            { id: 'show_balance_analysis', label: 'Visa balansanalys' },
            { id: 'review_reclassifications', label: 'Granska omklassificeringar' },
          ],
          { comparedValues: { soliditet_pct: overviewRow.soliditet_pct } },
        ),
      )
    }
  }

  const negativeLiabilities = data.balansrakning.equity_liabilities.filter(
    (line) => /skuld|avsättning/i.test(line.label) && line.amount < 0,
  )
  for (const line of negativeLiabilities) {
    add(
      issue(
        'ABNORMAL_LIABILITY_DIRECTION',
        'blocking',
        'presentation',
        `${line.label} har negativt presenterat skuldsaldo. Välj presentationsomklassificering eller bokföringsrättelse.`,
        [
          { id: 'create_presentation_reclassification', label: 'Omklassificera i årsredovisningen' },
          { id: 'request_reopen', label: 'Återöppna året för rättelse' },
          { id: 'show_account_analysis', label: 'Visa kontoanalys' },
        ],
        { comparedValues: { amount: line.amount } },
      ),
    )
  }

  const serialized = JSON.stringify(data)
  if (containsForbiddenAnnualReportCharacters(serialized)) {
    add(
      issue(
        'FORBIDDEN_CONTROL_CHARACTER',
        'blocking',
        'presentation',
        'Årsredovisningsunderlaget innehåller ett dolt kontrolltecken eller ett icke-kanoniskt minustecken.',
        [{ id: 'normalize_document_text', label: 'Normalisera dokumenttext' }],
      ),
    )
  }

  if (state.pdf_ixbrl_match === false) {
    add(
      issue(
        'PDF_IXBRL_MISMATCH',
        'blocking',
        'archive',
        'PDF och iXBRL har olika kärnbelopp.',
        [{ id: 'show_pdf_ixbrl_comparison', label: 'Visa kontrollrapport' }],
      ),
    )
  }
  if (state.final_pdf_requested && state.pdf_text_contains_draft !== false) {
    add(
      issue(
        'FINAL_PDF_CONTAINS_DRAFT',
        'blocking',
        'archive',
        'Slutlig PDF innehåller eller kan inte bevisas sakna texten UTKAST.',
        [{ id: 'regenerate_final_pdf', label: 'Generera om slutfilen' }],
      ),
    )
  }

  const blockingIssueCount = issues.filter((entry) => entry.severity === 'blocking').length
  return {
    preflight_status: blockingIssueCount === 0 ? 'passed' : 'failed',
    blocking_issue_count: blockingIssueCount,
    warning_count: issues.length - blockingIssueCount,
    issues,
  }
}
