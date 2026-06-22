'use client'

import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import type { CompanyRegistryLookupStatus } from './types'

export function CompanyRegistryLookupStatusLine({
  status,
  message,
}: {
  status: CompanyRegistryLookupStatus
  message: string | null
}) {
  if (status === 'idle' || !message) return null

  const tone = status === 'found'
    ? 'text-primary'
    : status === 'searching'
      ? 'text-muted-foreground'
      : status === 'invalid' || status === 'not_found' || status === 'unavailable'
        ? 'text-muted-foreground'
        : 'text-destructive'

  const icon = status === 'searching'
    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
    : status === 'found'
      ? <CheckCircle2 className="h-3.5 w-3.5" />
      : <AlertTriangle className="h-3.5 w-3.5" />

  return (
    <div className={`flex items-center gap-2 text-sm ${tone}`}>
      {icon}
      <span>{message}</span>
    </div>
  )
}
