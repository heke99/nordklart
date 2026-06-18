import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { checkFeatureAccess, featureAccessError, NORDKLART_FEATURES, type FeatureCode } from '@/lib/platform/entitlements'

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
  if (normalized.startsWith('year_end.') || normalized.includes('arsredovisning') || normalized.includes('ixbrl')) {
    return normalized.includes('ixbrl') ? NORDKLART_FEATURES.yearEndIxbrl : NORDKLART_FEATURES.yearEndProjects
  }
  if (normalized.startsWith('invoice.') || normalized.startsWith('invoices.') || normalized.startsWith('customer_invoice.') || normalized.startsWith('customer_invoices.')) return NORDKLART_FEATURES.invoicingCore
  if (normalized.startsWith('report.') || normalized.startsWith('reports.') || normalized.startsWith('analytics.') || normalized.startsWith('export.')) return NORDKLART_FEATURES.reportsCore
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
    'bookkeeping.', 'journal.', 'journals.', 'account.', 'accounts.', 'fiscal_period.', 'fiscal_periods.', 'transaction.', 'transactions.',
    'supplier_invoice.', 'supplier.', 'receipt.', 'cash_account.', 'vat.',
  ]
  if (bookkeepingPrefixes.some((prefix) => normalized.startsWith(prefix))) return NORDKLART_FEATURES.bookkeepingCore

  return null
}

/**
 * v1 routes use endpoint names that vary slightly from dashboard operations.
 * Keep the mapping conservative: unknown operations remain available only when
 * their API key scope permits them, while known commercial modules are gated.
 */
export function featureForApiV1Operation(operation: string): FeatureCode | null {
  const normalized = operation.toLowerCase()
  if (normalized.includes('webhook')) return NORDKLART_FEATURES.apiWebhooks
  if (normalized.includes('bankgiro')) return normalized.includes('application') ? NORDKLART_FEATURES.bankgiroApplication : NORDKLART_FEATURES.bankgiroOperations
  if (normalized.includes('year_end') || normalized.includes('ixbrl')) return normalized.includes('ixbrl') ? NORDKLART_FEATURES.yearEndIxbrl : NORDKLART_FEATURES.yearEndProjects
  if (normalized.includes('invoice')) return NORDKLART_FEATURES.invoicingCore
  if (normalized.includes('report') || normalized.includes('analytics')) return NORDKLART_FEATURES.reportsCore
  if (normalized.includes('bank')) return NORDKLART_FEATURES.bankAutomation
  if (normalized.includes('agency') || normalized.includes('client')) return NORDKLART_FEATURES.agencyClients
  if (normalized.includes('journal') || normalized.includes('bookkeeping') || normalized.includes('account') || normalized.includes('transaction') || normalized.includes('supplier')) return NORDKLART_FEATURES.bookkeepingCore
  return null
}


/** Returns a canonical 403 response when a legacy route is not yet wrapped. */
export async function requireCompanyFeatureResponse(
  supabase: SupabaseClient,
  companyId: string,
  featureCode: FeatureCode,
): Promise<Response | null> {
  const access = await checkFeatureAccess(supabase, companyId, featureCode)
  return access.allowed ? null : featureAccessError(featureCode)
}
