import type { OnboardingProgress } from '@/types'

export interface DashboardWorkspaceCounts {
  customerCount?: number | null
  invoiceCount?: number | null
  receiptCount?: number | null
  transactionCount?: number | null
  postedEntriesCount?: number | null
  sieImportCount?: number | null
  bankConnectionCount?: number | null
  skatteverketTokenCount?: number | null
}

export interface DashboardWorkspaceState {
  hasCustomers: boolean
  hasInvoices: boolean
  hasReceipts: boolean
  hasTransactions: boolean
  hasPostedEntries: boolean
  hasSieImport: boolean
  hasBankConnection: boolean
  hasSkatteverketConnection: boolean
  hasAccountingActivity: boolean
  isEmptyWorkspace: boolean
  onboardingProgress: OnboardingProgress
}

function hasAny(count: number | null | undefined): boolean {
  return (count ?? 0) > 0
}

/**
 * Central dashboard state for a provisioned company.
 *
 * The dashboard must remain available even when the company has no bank
 * connection, no SIE import and no posted entries. Those are optional next
 * actions, not access gates. Bank connection status is therefore based on real
 * bank_connections rows, not on synced transactions.
 */
export function resolveDashboardWorkspaceState(counts: DashboardWorkspaceCounts): DashboardWorkspaceState {
  const hasCustomers = hasAny(counts.customerCount)
  const hasInvoices = hasAny(counts.invoiceCount)
  const hasReceipts = hasAny(counts.receiptCount)
  const hasTransactions = hasAny(counts.transactionCount)
  const hasPostedEntries = hasAny(counts.postedEntriesCount)
  const hasSieImport = hasAny(counts.sieImportCount)
  const hasBankConnection = hasAny(counts.bankConnectionCount)
  const hasSkatteverketConnection = hasAny(counts.skatteverketTokenCount)

  const hasAccountingActivity =
    hasCustomers ||
    hasInvoices ||
    hasReceipts ||
    hasTransactions ||
    hasPostedEntries ||
    hasSieImport

  return {
    hasCustomers,
    hasInvoices,
    hasReceipts,
    hasTransactions,
    hasPostedEntries,
    hasSieImport,
    hasBankConnection,
    hasSkatteverketConnection,
    hasAccountingActivity,
    isEmptyWorkspace: !hasAccountingActivity,
    onboardingProgress: {
      hasCustomers,
      hasInvoices,
      hasBankConnected: hasBankConnection,
      hasSIEImport: hasSieImport,
      hasSkatteverketConnected: hasSkatteverketConnection,
    },
  }
}
