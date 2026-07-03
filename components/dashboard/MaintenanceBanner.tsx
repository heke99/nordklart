import { AlertTriangle } from 'lucide-react'

/**
 * Incident/maintenance banner. Rendered by the dashboard layout when
 * MAINTENANCE_MODE is 'banner' or 'read_only' (server component — the mode
 * is resolved server-side and passed in, so no client env access needed).
 */
export function MaintenanceBanner({
  message,
  readOnly,
}: {
  message: string
  readOnly: boolean
}) {
  return (
    <div
      className={`relative z-50 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-10 py-2 text-sm sm:px-4 ${
        readOnly ? 'bg-destructive text-destructive-foreground' : 'bg-warning text-warning-foreground'
      }`}
      role="status"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="text-center text-xs font-medium sm:text-sm">
        {message}
        {readOnly ? ' Ändringar kan inte sparas just nu.' : ''}
      </span>
    </div>
  )
}
