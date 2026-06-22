'use client'

import QuickStartPanel from '@/components/dashboard/QuickStartPanel'

interface Props {
  companyId: string
  hasBookkeepingImported: boolean
  hasBankConnected: boolean
  hasSkatteverketConnected: boolean
}

// Legacy wrapper kept for older imports. It must never block /app: a company
// with no bank connection, SIE import or Skatteverket token should still see
// the normal dashboard and choose these setup steps when it fits.
export default function WelcomeGate({
  companyId,
  hasBookkeepingImported: _hasBookkeepingImported,
  hasBankConnected: _hasBankConnected,
  hasSkatteverketConnected: _hasSkatteverketConnected,
}: Props) {
  return <QuickStartPanel companyId={companyId} />
}
