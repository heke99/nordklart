/**
 * Pure operation → feature mapping.
 *
 * This module intentionally contains no `server-only` import and no Supabase
 * dependency so the CI coverage script (`scripts/check-feature-policy-coverage.ts`)
 * and unit tests can evaluate the exact production mapping. Application code
 * imports these via `@/lib/platform/feature-policy`, which re-exports
 * everything here.
 */

import { NORDKLART_FEATURES, type FeatureCode } from '@/lib/platform/feature-codes'

/**
 * Operations that are deliberately NOT commercial-feature-gated because they
 * are part of the core product every authenticated company user gets
 * (settings surfaces, dashboard counters, reference lookups, BankID consent
 * evidence). Every entry needs a reason — this list is reviewed by
 * `scripts/check-feature-policy-coverage.ts`, not a dumping ground.
 */
export const CORE_OPERATION_PREFIXES: ReadonlyArray<{ prefix: string; reason: string }> = [
  {
    prefix: 'bankid.consents.',
    // Documented core: BankID-verified consent evidence underpins signing in
    // multiple products (årsredovisning, invoice financing, agency data
    // sharing). Gating consent creation on a paid feature would block the
    // legally-required consent step of flows that are themselves gated.
    reason: 'BankID-samtycken är kärnfunktion som stödjer flera betalda flöden.',
  },
  {
    prefix: 'automation.settings.',
    // Settings surface — the automation features it configures are gated at
    // execution time. Legacy plans without bookkeeping.automation must still
    // be able to view/adjust their own settings page.
    reason: 'Inställningsyta; automationskörningar gates separat.',
  },
  {
    prefix: 'salary.tax_tables.',
    reason: 'Statisk referensdata (kommunlista) utan bolagsdata.',
  },
  {
    prefix: 'worklist.',
    reason: 'Dashboardräknare över bolagets egna poster.',
  },
  {
    prefix: 'integrations.',
    reason: 'Statusöversikt över bolagets kopplingar (läs-endast).',
  },
  {
    prefix: 'agent.',
    // The in-app assistant surface: conversations, memory, profile, the skill
    // catalogue. What the assistant DOES is gated where it executes — a
    // bookkeeping action it proposes still goes through the bookkeeping gate
    // when committed (see bookkeeping.pending_operation.*). Gating the
    // assistant itself would gate the explanation rather than the action.
    reason: 'Assistentyta; det den utför gates där det utförs.',
  },
  {
    prefix: 'settings.',
    // The company's own configuration surface. The features these settings
    // configure are gated where they execute, not where they are typed in —
    // the same reasoning the existing `automation.settings.` entry records.
    // A customer on a reduced plan must still be able to see and correct their
    // own company details, logo and invoicing defaults.
    reason: 'Inställningsyta; funktionerna den konfigurerar gates vid körning.',
  },
  {
    prefix: 'booking_template.',
    // Saved posting templates, company- or team-scoped. They are a
    // convenience over the chart of accounts, not a separate product: the
    // bookkeeping they shortcut is gated at the point a voucher is written.
    reason: 'Sparade konteringsmallar; bokföringen de förkortar gates vid bokning.',
  },
  {
    prefix: 'counterparty_template.',
    reason: 'Motpartsmallar; samma resonemang som konteringsmallar.',
  },
  {
    prefix: 'deadline.',
    // The company's calendar of statutory due dates (momsdeklaration, AGI,
    // årsredovisning). Gating it would mean a customer whose plan lapsed stops
    // being told that a Skatteverket deadline is approaching — the obligation
    // does not lapse with the subscription, so neither should the reminder.
    reason: 'Lagstadgade förfallodatum; skyldigheten kvarstår oavsett plan.',
  },
  {
    prefix: 'pending_operation.',
    // Staging surface for operations awaiting confirmation: list, inspect,
    // amend the preview, discard. None of these touch the ledger.
    //
    // Committing DOES touch the ledger, and is deliberately NOT covered by
    // this prefix — `bookkeeping.pending_operation.commit` and `.bulk_commit`
    // resolve to bookkeeping.core through the `bookkeeping.` prefix instead.
    // commitPendingOperation() calls createJournalEntry(), so a commit is a
    // journal entry by another name; leaving it free would let a customer
    // without bookkeeping.core write vouchers through the side door while
    // POST /api/bookkeeping/journal-entries refuses them at the front.
    reason: 'Staging-yta utan huvudboksskrivning; commit gates separat på bookkeeping.core.',
  },
  {
    prefix: 'document.',
    // Räkenskapsinformation. BFL 7 kap requires the company to be able to
    // reach its own verifikationsunderlag for seven years, and that duty does
    // not lapse when a subscription does — the customer whose plan ended is
    // exactly the one who still has to produce receipts for Skatteverket.
    //
    // This entry DELIBERATELY LOOSENS four routes that were gated on
    // bookkeeping.core before it: document.upload, document.list,
    // document.link and document.inbox_available. That was not a considered
    // policy — the surface had simply been converted piecemeal, leaving a
    // split where a customer could not LIST their own documents but could
    // still fetch one by id. Freeing the whole surface is the coherent
    // resolution and was signed off as a commercial decision, not a security
    // one. Do not "fix" this back to a gate without revisiting that call.
    //
    // Scope is the dashboard only: featureForApiV1Operation() does not consult
    // CORE_OPERATION_PREFIXES, so the paid v1 API keeps its own gating.
    reason: 'Räkenskapsinformation enligt BFL 7 kap; åtkomlig i sju år oavsett plan.',
  },
  {
    prefix: 'user_account.',
    // The user-account surface (password, email, locale, MFA, account
    // deletion) belongs to the person, not the company, and must keep working
    // on any plan — including a lapsed or downgraded one. Locking someone out
    // of their own password change because their bookkeeping entitlement
    // expired is the false-paywall defect class, applied to account recovery.
    //
    // The prefix is `user_account.`, NOT `account.`, and that is deliberate:
    // `account.` is already claimed by the bookkeeping prefix list below,
    // where it means a chart-of-accounts account (BAS 1930 etc.). The two
    // senses of the word collide, and the bookkeeping one got there first.
    // Naming a route in app/api/account/ `account.password` resolves to
    // bookkeeping.core — verified — and the `normalized.includes('account')`
    // fallback catches it too, so both paths must be bypassed. This entry is
    // read before either.
    reason: 'Användarens eget konto; måste fungera oavsett bolagets plan.',
  },
]

/**
 * Operations reserved for platform staff. Routes using these operations MUST
 * enforce `requirePlatformRole()` / `requirePlatformAdmin()` in the handler —
 * they are never commercial-feature-gated (platform staff are not customers).
 */
export const PLATFORM_OPERATION_PREFIXES: ReadonlyArray<string> = ['platform.']

/**
 * Fiscal-period-bound year-end/declaration operations are gated inside their
 * route handlers with requireYearEndAccess(), because a one-time purchase is
 * tied to a specific fiscal_period_id that the generic wrapper cannot see.
 * The coverage script verifies those route files actually call
 * requireYearEndAccess().
 */
export function isPeriodBoundYearEndOperation(operation: string): boolean {
  const normalized = operation.toLowerCase()
  return (
    normalized.startsWith('period.year_end')
    || normalized.startsWith('period.bokslut')
    || normalized.startsWith('period.arsredovisning')
    || normalized.startsWith('period.accruals_')
    || normalized.startsWith('period.depreciation_')
    || normalized === 'report.ink2'
    || normalized === 'report.ne_bilaga'
    || normalized === 'report.balance_sheet'
    || normalized === 'report.income_statement'
    || normalized === 'report.general_ledger'
    || normalized.startsWith('tax_declaration.')
    // v1 API: year-end closing on a specific fiscal period. The wrapper's
    // company-wide feature check would wrongly deny one-time buyers (their
    // purchase is bound to one fiscal_period_id) — requireYearEndAccess in
    // the route handler resolves subscription OR period purchase correctly.
    || normalized === 'fiscal-periods.year-end'
  )
}


/**
 * SIE import is available either through bookkeeping.core or a period-bound
 * one-off year-end purchase. Routes must therefore use the dedicated
 * `accessPolicy: 'sie_import'` resolver instead of a company-wide feature.
 */
export function isSieImportOperation(operation: string): boolean {
  const normalized = operation.toLowerCase()
  return normalized.startsWith('sie_import.') || normalized.startsWith('imports.sie.')
}

export function isCoreOperation(operation: string): boolean {
  const normalized = operation.toLowerCase()
  return CORE_OPERATION_PREFIXES.some(({ prefix }) => normalized.startsWith(prefix))
}

export function isPlatformOperation(operation: string): boolean {
  const normalized = operation.toLowerCase()
  return PLATFORM_OPERATION_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * Central feature-policy registry. It intentionally maps product operations,
 * not routes, so every new route using the shared wrappers receives the same
 * server-side commercial check without a UI-only dependency.
 */
export function featureForOperation(operation: string): FeatureCode | null {
  const normalized = operation.toLowerCase()

  if (normalized.startsWith('bankgiro.')) {
    if (normalized.includes('onboarding') || normalized.includes('application')) return NORDKLART_FEATURES.bankgiroApplication
    return NORDKLART_FEATURES.bankgiroOperations
  }
  if (isPeriodBoundYearEndOperation(normalized) || isSieImportOperation(normalized)) {
    return null
  }
  if (isCoreOperation(normalized) || isPlatformOperation(normalized)) {
    return null
  }
  if (normalized.startsWith('year_end.') || normalized.includes('ixbrl')) {
    return normalized.includes('ixbrl') ? NORDKLART_FEATURES.yearEndIxbrl : NORDKLART_FEATURES.yearEndProjects
  }
  if (
    normalized.startsWith('invoice.')
    || normalized.startsWith('invoices.')
    || normalized.startsWith('customer_invoice.')
    || normalized.startsWith('customer_invoices.')
    || normalized.startsWith('recurring_invoice.')
    || normalized.startsWith('invoice_financing.')
    || normalized.startsWith('customer.')
    || normalized.startsWith('customers.')
    || normalized.startsWith('article.')
    || normalized.startsWith('articles.')
  ) {
    return NORDKLART_FEATURES.invoicingCore
  }
  // Skatteverket filing flows (moms/AGI validation & submission). Note:
  // tax-payment helper routes (skattekonto payment files, mark-paid) do NOT
  // use this prefix — they never call the Skatteverket API and stay gated on
  // bookkeeping.core so Start-plan customers keep basic tax bookkeeping.
  if (normalized.startsWith('skatteverket.')) return NORDKLART_FEATURES.skatteverketSubmissions
  if (normalized.startsWith('salary_run.') || normalized.startsWith('salary.')) return NORDKLART_FEATURES.salaryRuns
  if (normalized.startsWith('report.') || normalized.startsWith('reports.') || normalized.startsWith('analytics.') || normalized.startsWith('export.')) return NORDKLART_FEATURES.reportsCore
  // Bank reconciliation. app/api/reconciliation/** already gates on
  // bank.matching through requireCompanyFeatureResponse; without this rule the
  // derived operation resolves to nothing, and moving those routes onto
  // withRouteContext would silently drop a paid gate.
  if (normalized.startsWith('reconciliation.')) return NORDKLART_FEATURES.bankMatching
  if (normalized.startsWith('bank_file.')) return NORDKLART_FEATURES.bankTransactionIngest
  if (normalized.startsWith('bank.')) {
    if (normalized.includes('match')) return NORDKLART_FEATURES.bankMatching
    if (normalized.includes('autobook')) return NORDKLART_FEATURES.bankAutobook
    if (normalized.includes('ingest') || normalized.includes('transaction')) return NORDKLART_FEATURES.bankTransactionIngest
    return NORDKLART_FEATURES.bankAutomation
  }
  if (normalized.startsWith('agency.') || normalized.startsWith('client-workspace.')) return NORDKLART_FEATURES.agencyClients
  if (normalized.startsWith('webhook.')) return NORDKLART_FEATURES.apiWebhooks
  if (normalized.startsWith('api_key.') || normalized.startsWith('api.')) return NORDKLART_FEATURES.apiAccess

  const bookkeepingPrefixes = [
    'bookkeeping.', 'journal.', 'journals.', 'journal_entry.', 'account.', 'accounts.', 'fiscal_period.', 'fiscal_periods.',
    'period.', 'transaction.', 'transactions.', 'supplier_invoice.', 'supplier.', 'receipt.', 'cash_account.', 'vat.',
    'asset.', 'assets.', 'accounting_rule.', 'accounting_rules.', 'accruals.', 'voucher_sequence.', 'opening_balance.',
    'sie_import.', 'register_import.', 'document.', 'documents.',
  ]
  if (bookkeepingPrefixes.some((prefix) => normalized.startsWith(prefix))) return NORDKLART_FEATURES.bookkeepingCore

  return null
}

/**
 * v1 API operations that are deliberately not feature-gated: account-level
 * surfaces every API key holder needs regardless of plan (the key itself is
 * already gated on `api.access` at issuance, and every operation is
 * scope-checked). Reviewed by the coverage script.
 */
export const API_V1_CORE_OPERATIONS: ReadonlyArray<{ operation: string; reason: string }> = [
  { operation: 'health.check', reason: 'Publik hälsokontroll.' },
  { operation: 'companies.list', reason: 'Kontoyta: lista bolag nyckeln når.' },
  { operation: 'companies.get', reason: 'Kontoyta: bolagsmetadata.' },
  { operation: 'operations.get', reason: 'Statusuppslag för asynkrona operationer.' },
  { operation: 'events.list', reason: 'Händelselogg för integrationsfelsökning.' },
  { operation: 'audit_logs.list', reason: 'Revisionslogg (läs-endast).' },
  { operation: 'compliance.check', reason: 'Compliance-kontroll av eget bolag (läs-endast).' },
]

export function isApiV1CoreOperation(operation: string): boolean {
  const normalized = operation.toLowerCase()
  return API_V1_CORE_OPERATIONS.some((entry) => entry.operation === normalized)
}

/**
 * v1 routes use endpoint names that vary slightly from dashboard operations.
 * Keep the mapping conservative: unknown operations remain available only when
 * their API key scope permits them, while known commercial modules are gated.
 */
export function featureForApiV1Operation(operation: string): FeatureCode | null {
  const normalized = operation.toLowerCase()
  if (isPeriodBoundYearEndOperation(normalized)) return null
  if (normalized.includes('webhook')) return NORDKLART_FEATURES.apiWebhooks
  if (normalized.includes('bankgiro')) return normalized.includes('application') ? NORDKLART_FEATURES.bankgiroApplication : NORDKLART_FEATURES.bankgiroOperations
  if (normalized.includes('year_end') || normalized.includes('year-end') || normalized.includes('ixbrl')) return normalized.includes('ixbrl') ? NORDKLART_FEATURES.yearEndIxbrl : NORDKLART_FEATURES.yearEndProjects
  if (normalized.includes('tax_submission') || normalized.includes('skatteverket')) return NORDKLART_FEATURES.skatteverketSubmissions
  if (normalized.includes('salary')) return NORDKLART_FEATURES.salaryRuns
  if (normalized.includes('employee')) return NORDKLART_FEATURES.payrollEmployees
  if (normalized.includes('invoice')) return NORDKLART_FEATURES.invoicingCore
  if (normalized.includes('customer') || normalized.includes('article')) return NORDKLART_FEATURES.invoicingCore
  if (normalized.includes('report') || normalized.includes('analytics')) return NORDKLART_FEATURES.reportsCore
  if (normalized.includes('bank')) return NORDKLART_FEATURES.bankAutomation
  if (normalized.includes('agency') || normalized.includes('client')) return NORDKLART_FEATURES.agencyClients
  if (
    normalized.includes('journal')
    || normalized.includes('bookkeeping')
    || normalized.includes('account')
    || normalized.includes('transaction')
    || normalized.includes('supplier')
    || normalized.includes('fiscal-period')
    || normalized.includes('fiscal_period')
    || normalized.includes('voucher')
    || normalized.includes('document')
    || normalized.startsWith('imports.')
  ) {
    return NORDKLART_FEATURES.bookkeepingCore
  }
  return null
}
