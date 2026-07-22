import { NORDKLART_FEATURES, type FeatureCode } from '@/lib/platform/feature-codes'

/**
 * Dashboard page families that require commercial access before rendering.
 * Keep this ordered from most specific to least specific.
 */
const DASHBOARD_FEATURE_ROUTES: ReadonlyArray<readonly [string, FeatureCode]> = [
  ['/payments/bankgiro', NORDKLART_FEATURES.bankgiroApplication],
  ['/bank-automation', NORDKLART_FEATURES.bankAutomation],
  ['/bookkeeping/year-end', NORDKLART_FEATURES.yearEndProjects],
  ['/supplier-invoices', NORDKLART_FEATURES.bookkeepingCore],
  ['/transactions', NORDKLART_FEATURES.bookkeepingCore],
  ['/bookkeeping', NORDKLART_FEATURES.bookkeepingCore],
  ['/skattekonto', NORDKLART_FEATURES.bookkeepingCore],
  ['/expenses', NORDKLART_FEATURES.bookkeepingCore],
  ['/receipts', NORDKLART_FEATURES.bookkeepingCore],
  ['/suppliers', NORDKLART_FEATURES.bookkeepingCore],
  ['/assets', NORDKLART_FEATURES.bookkeepingCore],
  ['/import', NORDKLART_FEATURES.bookkeepingCore],
  ['/invoices', NORDKLART_FEATURES.invoicingCore],
  ['/customers', NORDKLART_FEATURES.invoicingCore],
  ['/articles', NORDKLART_FEATURES.invoicingCore],
  ['/reports', NORDKLART_FEATURES.reportsCore],
  ['/kpi', NORDKLART_FEATURES.reportsCore],
  ['/skatteverket', NORDKLART_FEATURES.skatteverketSubmissions],
  ['/year-end', NORDKLART_FEATURES.yearEndProjects],
  ['/salary', NORDKLART_FEATURES.salaryRuns],
  ['/automation', NORDKLART_FEATURES.bookkeepingAutomation],
  ['/chat', NORDKLART_FEATURES.aiAssistant],
]

export function featureForDashboardPath(pathname: string): FeatureCode | null {
  const normalized = pathname.split('?')[0].replace(/\/$/, '') || '/'
  return DASHBOARD_FEATURE_ROUTES.find(([prefix]) => (
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  ))?.[1] ?? null
}

export function purchaseFocusForFeature(featureCode: string): 'plans' | 'year-end' | 'bankgiro' {
  if (featureCode.startsWith('bankgiro.')) return 'bankgiro'
  if (featureCode.startsWith('year_end.')) return 'year-end'
  return 'plans'
}

/**
 * Canonical destination for a missing commercial feature. The billing page
 * uses the feature code to recommend and highlight a plan/add-on/one-time SKU
 * that actually contains the requested feature.
 */
export function purchaseHrefForFeature(featureCode: string, returnTo?: string): string {
  const params = new URLSearchParams({ feature: featureCode })
  if (returnTo?.startsWith('/')) params.set('return_to', returnTo)
  const focus = purchaseFocusForFeature(featureCode)
  return `/settings/billing?${params.toString()}#${focus}`
}
