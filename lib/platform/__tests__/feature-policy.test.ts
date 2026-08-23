/**
 * Unit tests for the operation → feature mapping (feature-policy-map.ts).
 *
 * The mapping is production access control: withRouteContext/withApiV1 skip
 * the commercial gate entirely when featureForOperation returns null, so
 * every monetized operation prefix must resolve to a real feature code.
 */
import { describe, it, expect } from 'vitest'
import {
  featureForOperation,
  featureForApiV1Operation,
  isCoreOperation,
  isPlatformOperation,
  isPeriodBoundYearEndOperation,
  isSieImportOperation,
  isApiV1CoreOperation,
} from '@/lib/platform/feature-policy-map'
import { NORDKLART_FEATURES } from '@/lib/platform/feature-codes'

describe('featureForOperation', () => {
  it('maps invoicing operations to invoicing.core', () => {
    expect(featureForOperation('invoice.create')).toBe(NORDKLART_FEATURES.invoicingCore)
    expect(featureForOperation('invoices.list')).toBe(NORDKLART_FEATURES.invoicingCore)
    expect(featureForOperation('customer_invoice.get')).toBe(NORDKLART_FEATURES.invoicingCore)
    expect(featureForOperation('customer_invoices.list')).toBe(NORDKLART_FEATURES.invoicingCore)
  })

  it('maps recurring invoice operations to invoicing.core', () => {
    expect(featureForOperation('recurring_invoice.create')).toBe(NORDKLART_FEATURES.invoicingCore)
    expect(featureForOperation('recurring_invoice.list')).toBe(NORDKLART_FEATURES.invoicingCore)
    expect(featureForOperation('recurring_invoice.update')).toBe(NORDKLART_FEATURES.invoicingCore)
    expect(featureForOperation('recurring_invoice.delete')).toBe(NORDKLART_FEATURES.invoicingCore)
  })

  it('maps customer/article registry operations to invoicing.core', () => {
    expect(featureForOperation('customer.create')).toBe(NORDKLART_FEATURES.invoicingCore)
    expect(featureForOperation('article.update')).toBe(NORDKLART_FEATURES.invoicingCore)
    expect(featureForOperation('invoice_financing.accept')).toBe(NORDKLART_FEATURES.invoicingCore)
  })

  it('maps skatteverket operations to skatteverket.submissions', () => {
    expect(featureForOperation('skatteverket.sysorg.moms.validate')).toBe(NORDKLART_FEATURES.skatteverketSubmissions)
    expect(featureForOperation('skatteverket.agi.submit')).toBe(NORDKLART_FEATURES.skatteverketSubmissions)
  })

  it('maps salary operations to salary.runs but keeps reference lookups core', () => {
    expect(featureForOperation('salary_run.create')).toBe(NORDKLART_FEATURES.salaryRuns)
    expect(featureForOperation('salary_run.list')).toBe(NORDKLART_FEATURES.salaryRuns)
    expect(featureForOperation('salary.tax_tables.kommuner')).toBeNull()
    expect(isCoreOperation('salary.tax_tables.kommuner')).toBe(true)
  })

  it('maps bookkeeping-family operations to bookkeeping.core', () => {
    expect(featureForOperation('journal_entry.batch_no_document_required')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForOperation('accruals.post_due')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForOperation('voucher_sequence.next')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForOperation('register_import.customers.parse')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForOperation('opening_balance.execute')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForOperation('period.lock')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    // `document.upload` used to be asserted here. It is now core — see
    // 'never gates the document archive on a company entitlement' below.
    // The document surface is räkenskapsinformation under BFL 7 kap and was
    // deliberately freed; this line is left as a pointer so the removal reads
    // as a decision rather than an accident.
  })

  it('keeps SIE operations null because the dedicated resolver supports bookkeeping and one-off year-end access', () => {
    for (const op of ['sie_import.execute', 'sie_import.mappings.update', 'imports.sie.create']) {
      expect(featureForOperation(op)).toBeNull()
      expect(isSieImportOperation(op)).toBe(true)
    }
  })

  it('keeps period-bound year-end operations null (gated via requireYearEndAccess)', () => {
    for (const op of [
      'period.year_end',
      'period.year_end_preview',
      'period.bokslut_readiness',
      'period.arsredovisning_pdf',
      'period.accruals_preview',
      'period.depreciation_commit',
      'report.ink2',
      'report.ne_bilaga',
      'report.balance_sheet',
      'report.income_statement',
      'report.general_ledger',
      'tax_declaration.ef_preview',
    ]) {
      expect(featureForOperation(op)).toBeNull()
      expect(isPeriodBoundYearEndOperation(op)).toBe(true)
    }
  })

  it('maps bank operations to the bank feature family', () => {
    expect(featureForOperation('bank.match_run')).toBe(NORDKLART_FEATURES.bankMatching)
    expect(featureForOperation('bank.autobook')).toBe(NORDKLART_FEATURES.bankAutobook)
    expect(featureForOperation('bank.transaction_sync')).toBe(NORDKLART_FEATURES.bankTransactionIngest)
    expect(featureForOperation('bank.connect')).toBe(NORDKLART_FEATURES.bankAutomation)
    expect(featureForOperation('bank_file.parse')).toBe(NORDKLART_FEATURES.bankTransactionIngest)
  })

  it('maps bankgiro operations', () => {
    expect(featureForOperation('bankgiro.application.create')).toBe(NORDKLART_FEATURES.bankgiroApplication)
    expect(featureForOperation('bankgiro.payment.execute')).toBe(NORDKLART_FEATURES.bankgiroOperations)
  })

  it('maps reports/agency/api operations', () => {
    expect(featureForOperation('report.vat_declaration')).toBe(NORDKLART_FEATURES.reportsCore)
    expect(featureForOperation('agency.clients.list')).toBe(NORDKLART_FEATURES.agencyClients)
    expect(featureForOperation('api_key.create')).toBe(NORDKLART_FEATURES.apiAccess)
    expect(featureForOperation('webhook.manage.create')).toBe(NORDKLART_FEATURES.apiWebhooks)
  })

  it('treats bankid consents as a documented core operation (not feature-gated)', () => {
    expect(featureForOperation('bankid.consents.start')).toBeNull()
    expect(isCoreOperation('bankid.consents.start')).toBe(true)
    expect(isCoreOperation('bankid.consents.revoke')).toBe(true)
  })

  it('treats platform operations as platform-scoped, never feature-gated', () => {
    expect(featureForOperation('platform.companies.list')).toBeNull()
    expect(isPlatformOperation('platform.companies.list')).toBe(true)
    expect(isPlatformOperation('invoice.create')).toBe(false)
  })

  it('maps year_end and ixbrl operations', () => {
    expect(featureForOperation('year_end.projects.create')).toBe(NORDKLART_FEATURES.yearEndProjects)
    expect(featureForOperation('year_end.export_ixbrl')).toBe(NORDKLART_FEATURES.yearEndIxbrl)
  })

  it('returns null for unknown operations', () => {
    expect(featureForOperation('totally.unknown.operation')).toBeNull()
  })

  it('never gates the user-account surface on a company entitlement', () => {
    // The person's own account must keep working on any plan, including a
    // lapsed one — locking someone out of their own password change because
    // the company's bookkeeping entitlement expired is the false-paywall
    // defect applied to account recovery.
    for (const op of [
      'user_account.password',
      'user_account.email',
      'user_account.locale',
      'user_account.delete',
      'user_account.mfa.enroll',
    ]) {
      expect(featureForOperation(op)).toBeNull()
    }
  })

  it('never gates the document archive on a company entitlement', () => {
    // BFL 7 kap: the company must reach its own verifikationsunderlag for
    // seven years, including after a plan lapses. The first four below were
    // gated on bookkeeping.core before the `document.` core prefix existed —
    // they are listed explicitly so this test fails if that loosening is
    // silently reverted.
    for (const op of [
      'document.upload',
      'document.list',
      'document.link',
      'document.inbox_available',
      'document.get',
      'document.verify',
      'document.versions',
      'document.counts',
    ]) {
      expect(featureForOperation(op)).toBeNull()
    }
  })

  it('leaves the paid v1 document API gated when the dashboard surface is free', () => {
    // featureForApiV1Operation has its own resolution chain and does NOT read
    // CORE_OPERATION_PREFIXES. That separation is what keeps the BFL exemption
    // scoped to the dashboard instead of quietly ungating the paid API.
    expect(featureForApiV1Operation('documents.list')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForApiV1Operation('documents.download')).toBe(NORDKLART_FEATURES.bookkeepingCore)
  })

  it('still resolves chart-of-accounts operations to bookkeeping.core', () => {
    // `account.` means a BAS account here and is claimed by the bookkeeping
    // prefix list. That collision is the reason the user-account surface is
    // spelled `user_account.` — this pins that the bookkeeping sense is
    // unaffected, so the exemption above cannot silently widen.
    expect(featureForOperation('account.list')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForOperation('accounts.activate')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForOperation('account.password')).toBe(NORDKLART_FEATURES.bookkeepingCore)
  })
})

describe('featureForApiV1Operation', () => {
  it('maps monetized v1 modules', () => {
    expect(featureForApiV1Operation('invoices.create')).toBe(NORDKLART_FEATURES.invoicingCore)
    expect(featureForApiV1Operation('customers.bulk-create')).toBe(NORDKLART_FEATURES.invoicingCore)
    expect(featureForApiV1Operation('articles.update')).toBe(NORDKLART_FEATURES.invoicingCore)
    expect(featureForApiV1Operation('tax_submissions.create')).toBe(NORDKLART_FEATURES.skatteverketSubmissions)
    expect(featureForApiV1Operation('salary-runs.book')).toBe(NORDKLART_FEATURES.salaryRuns)
    expect(featureForApiV1Operation('employees.create')).toBe(NORDKLART_FEATURES.payrollEmployees)
    expect(featureForApiV1Operation('fiscal-periods.lock')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForApiV1Operation('imports.sie')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForApiV1Operation('documents.upload')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForApiV1Operation('voucher-gap-explanations.create')).toBe(NORDKLART_FEATURES.bookkeepingCore)
    expect(featureForApiV1Operation('reports.vat-declaration')).toBe(NORDKLART_FEATURES.reportsCore)
    expect(featureForApiV1Operation('year_end.projects.create')).toBe(NORDKLART_FEATURES.yearEndProjects)
    expect(featureForApiV1Operation('bankgiro_applications.create')).toBe(NORDKLART_FEATURES.bankgiroApplication)
    expect(featureForApiV1Operation('webhooks.create')).toBe(NORDKLART_FEATURES.apiWebhooks)
  })

  it('keeps the period-bound v1 year-end operation null (gated via requireYearEndAccess)', () => {
    // The wrapper's company-wide feature check would wrongly deny one-time
    // buyers whose purchase is bound to a single fiscal_period_id — the
    // route handler enforces requireYearEndAccess instead.
    expect(featureForApiV1Operation('fiscal-periods.year-end')).toBeNull()
    expect(isPeriodBoundYearEndOperation('fiscal-periods.year-end')).toBe(true)
  })

  it('keeps documented account-level operations core', () => {
    for (const op of ['health.check', 'companies.list', 'companies.get', 'operations.get', 'events.list', 'audit_logs.list', 'compliance.check']) {
      expect(featureForApiV1Operation(op)).toBeNull()
      expect(isApiV1CoreOperation(op)).toBe(true)
    }
  })

  it('does not mark unknown operations as core', () => {
    expect(isApiV1CoreOperation('some.new.thing')).toBe(false)
  })
})
