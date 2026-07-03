/**
 * Maintenance / read-only mode.
 *
 * Controlled via environment (no DB dependency — must work when the DB is
 * the thing that is broken):
 *
 *   MAINTENANCE_MODE=off        (default) normal operation
 *   MAINTENANCE_MODE=banner     show the incident banner, everything works
 *   MAINTENANCE_MODE=read_only  banner + all mutating dashboard routes
 *                               (withRouteContext requireWrite) return 503
 *
 *   MAINTENANCE_MESSAGE="..."   optional banner text override (Swedish)
 */

export type MaintenanceMode = 'off' | 'banner' | 'read_only'

export function getMaintenanceMode(): MaintenanceMode {
  const raw = process.env.MAINTENANCE_MODE
  if (raw === 'banner') return 'banner'
  if (raw === 'read_only' || raw === 'readonly') return 'read_only'
  return 'off'
}

export function maintenanceBlocksWrites(): boolean {
  return getMaintenanceMode() === 'read_only'
}

const DEFAULT_MESSAGE_SV =
  'Underhållsarbete pågår. Vissa funktioner kan vara tillfälligt begränsade.'

const READ_ONLY_MESSAGE_SV =
  'Systemet är tillfälligt i läsläge på grund av underhåll — ändringar kan inte sparas just nu. Försök igen om en stund.'

export function getMaintenanceMessage(): string {
  const custom = process.env.MAINTENANCE_MESSAGE?.trim()
  if (custom) return custom
  return getMaintenanceMode() === 'read_only' ? READ_ONLY_MESSAGE_SV : DEFAULT_MESSAGE_SV
}
