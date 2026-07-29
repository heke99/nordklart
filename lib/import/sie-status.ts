/**
 * Canonical SIE import state model.
 *
 * Keep this list byte-for-byte aligned with the `sie_imports_status_check`
 * constraint in the latest migration. Every server route and UI component
 * imports the type from here so a newly introduced database state cannot be
 * silently ignored by one layer.
 */
export const SIE_IMPORT_STATUSES = [
  'pending',
  'validating',
  'staged',
  'importing',
  'partial',
  'mapped',
  'completed',
  'failed',
  'replaced',
  'undone',
] as const

export type SIEImportStatus = (typeof SIE_IMPORT_STATUSES)[number]

export const SIE_IMPORT_STATUS_LABELS: Record<SIEImportStatus, string> = {
  pending: 'Väntar',
  validating: 'Valideras',
  staged: 'Förberedd',
  importing: 'Importeras',
  partial: 'Delvis genomförd',
  mapped: 'Konton mappade',
  completed: 'Slutförd',
  failed: 'Misslyckad',
  replaced: 'Ersatt',
  undone: 'Ångrad',
}

export const SIE_IMPORT_YEAR_END_BLOCKING_STATUSES = [
  'pending',
  'validating',
  'staged',
  'importing',
  'partial',
  'mapped',
  'failed',
] as const satisfies readonly SIEImportStatus[]

const statusSet = new Set<string>(SIE_IMPORT_STATUSES)

export function isSIEImportStatus(value: unknown): value is SIEImportStatus {
  return typeof value === 'string' && statusSet.has(value)
}

export function assertNeverSIEStatus(value: never): never {
  throw new Error(`Okänd SIE-importstatus: ${String(value)}`)
}
