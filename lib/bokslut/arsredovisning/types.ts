import type { K2FormalReportModel } from '@/lib/bokslut/formal-report/k2-model'

/**
 * Structured data for a K2 årsredovisning. Generated server-side from
 * income statement + balance sheet + asset register + salary data; passed
 * to the @react-pdf/renderer template + the in-app preview.
 */

export interface FlerarsoversiktRow {
  /** True when the underlying data could not be loaded (R09) — the row's
   *  numbers are unavailable, NOT zero. Blocks the final document. */
  data_missing?: boolean
  /** Fiscal-year name (e.g. "2025"). */
  year: string
  net_revenue: number
  result_after_financial: number
  /** Soliditet = eget kapital / totala tillgångar, in percent. */
  soliditet_pct: number | null
}

export interface EgenKapitalRow {
  label: string
  /** Total movement/value for backwards-compatible consumers. */
  amount: number
  /** Optional component columns used by the K2 equity roll-forward table. */
  aktiekapital?: number
  balanserat_resultat?: number
  arets_resultat?: number
  row_kind?: 'opening' | 'movement' | 'result' | 'closing'
}

export interface NoteEntry {
  /** Note number per K2 convention (1 = redovisningsprinciper). */
  number: number
  /** Short Swedish title. */
  title: string
  /** Note body — supports newlines. Generated from data when possible
   *  (avskrivningstider from asset register, medelantal from salary),
   *  manual otherwise. */
  body: string
}

export interface IncomeStatementLine {
  /** Föregående års jämförelsetal (R03). Null when no prior period exists. */
  prior_amount?: number | null
  label: string
  amount: number
  /** True for total / subtotal lines. */
  is_total?: boolean
}

export interface BalanceSheetLine {
  /** Föregående års jämförelsetal (R03). Null when no prior period exists. */
  prior_amount?: number | null
  label: string
  amount: number
  is_total?: boolean
  /** Indent depth for nested grouping (0 = top, 1 = subgroup). */
  indent?: number
}

export interface ArsredovisningData {
  company: {
    name: string
    org_number: string
    /** Företagets säte (Bolagsverket-registered registered office city).
     *  Used in the underskrifter "Stad, datum" line and the fastställelseintyg. */
    city: string | null
    /** Historical legal name retained from SIE/registry source data. */
    prior_legal_name?: string | null
  }
  fiscal_period: {
    id: string
    name: string
    period_start: string
    period_end: string
  }
  /** Which BFNAR framework the document was generated under. Drives PDF
   *  rendering branching (K3 has an additional kassaflöde + equity-changes
   *  page and a richer note set) and lets the UI label the document
   *  correctly. K2 is the default for AB without an explicit election. */
  accounting_framework: 'k2' | 'k3'
  /** Canonical row model shared by K2 PDF, preview, preflight and iXBRL. */
  formal_report?: K2FormalReportModel
  forvaltningsberattelse: {
    /** Beskrivning av verksamheten (företaget kan editera). */
    description: string
    /** Viktiga händelser (företaget kan editera). */
    important_events: string
    /** Verifierade händelser efter balansdagen, e.g. a legal-name change. */
    events_after_balance_sheet?: string
    /** Har kontrollbalansräkning upprättats? */
    kontrollbalans_required: boolean
    flerarsoversikt: FlerarsoversiktRow[]
    /** Förändring av eget kapital. */
    egen_kapital_changes: EgenKapitalRow[]
    /** Styrelsens förslag till resultatdisposition (manual input). */
    resultatdisposition: string
    /** ISO date of the årsstämma where the årsredovisning was adopted.
     *  Populates the fastställelseintyg date blank. Null means "not yet
     *  recorded" — PDF then leaves the blank. */
    agm_date: string | null
    /** AGM adoption is separate from the board proposal. */
    agm_accounts_adopted?: boolean | null
    agm_result_disposition_decision?: string | null
    certificate_signer_name?: string | null
    certificate_signer_role?: string | null
    certificate_signed_at?: string | null
  }
  resultatrakning: IncomeStatementLine[]
  balansrakning: {
    assets: BalanceSheetLine[]
    total_assets: number
    equity_liabilities: BalanceSheetLine[]
    total_equity_liabilities: number
    /** Prior-year totals for the jämförelse column (R03). */
    total_assets_prior?: number | null
    total_equity_liabilities_prior?: number | null
  }
  noter: NoteEntry[]
  /** K3-only: full kassaflödesanalys (indirect method) rendered as its own
   *  PDF page. K2 omits this entirely (per BFNAR 2016:10 kassaflöde is not
   *  required for K2 mindre företag). */
  kassaflodesanalys?: KassaflodesAnalysisSummary
  /** K3-only: separate "Förändring av eget kapital" statement. K2 keeps the
   *  egen_kapital_changes inside förvaltningsberättelsen; K3 lifts it out
   *  into its own statement per ÅRL 6:5 + BFNAR 2012:1 ch.6. */
  equity_changes_statement?: {
    rows: EgenKapitalRow[]
    closing_total: number
  }
  /** Underskrifter — names of board members + VD from the canonical
   *  signature model (R04). Never generic placeholder persons. */
  signatures: {
    role: string
    name: string
    signed_at: string | null
    status?: 'pending' | 'signed' | 'declined'
  }[]
  /** Prior period metadata for the jämförelse column (R03). */
  prior_period?: {
    id: string
    name: string
    source_type?: 'established_annual_report' | 'final_report_snapshot' | 'manually_verified' | null
    source_label?: string | null
    verified_at?: string | null
    verified_by?: string | null
  } | null
  /** Förvaltningsberättelse fields still on unconfirmed boilerplate (R10).
   *  Non-empty blocks the FINAL document — standard texts asserting facts
   *  require active user confirmation. */
  unconfirmed_defaults: string[]
  /** Pre-download blockers / warnings the UI surfaces so the user knows the
   *  PDF is not yet Bolagsverket-fileable as-is. Examples: aktiekapital
   *  uppgifter saknas, AGM-datum saknas, K3 entity. Never an error — the
   *  user can still download to iterate. */
  warnings: string[]
  /** Manual disclosure overrides persisted on arsredovisning_narratives.
   *  Drive the long-term debt, säkerheter, eventualförpliktelser, and
   *  koncernförhållanden notes. Null means "use the boilerplate". */
  disclosures: {
    long_term_debt_over_five_years: number | null
    securities_pledged: string | null
    contingent_liabilities: string | null
    parent_company_name: string | null
    parent_company_org_number: string | null
    parent_company_city: string | null
  }
}

/**
 * Light summary of kassaflödesanalys carried in ArsredovisningData. We
 * embed a flat shape rather than the full KassaflodesanalysReport so that
 * the data builder can produce it without forcing all callers / tests to
 * also mock the kassaflöde generator. The K3 PDF renderer reads only these
 * fields; if you need the full structured report use generateKassaflodesanalys
 * directly.
 */
export interface KassaflodesAnalysisSummary {
  period_start: string
  period_end: string
  lopande: {
    resultat_efter_finansiella_poster: number
    avskrivningar: number
    ovriga_ej_kassaflodesposter: number
    delta_kortfristiga_fordringar: number
    delta_varulager: number
    delta_kortfristiga_skulder: number
    skatt_betald: number
    total: number
  }
  investerings: {
    forvarv_anlaggningar: number
    avyttring_anlaggningar: number
    total: number
  }
  finansierings: {
    delta_lan: number
    utdelningar: number
    nyemission: number
    total: number
  }
  total_cash_flow: number
  reconciliation: {
    opening_cash_1xxx: number
    closing_cash_1xxx: number
    delta_actual: number
    delta_calculated: number
    mismatch_amount: number
    is_reconciled: boolean
  }
}
