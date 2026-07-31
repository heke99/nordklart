interface KeyStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function randomKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function getOrCreateYearEndExecutionKey(
  storage: KeyStorage,
  companyId: string | null,
  fiscalPeriodId: string,
  previewId: string,
): string {
  const scope = ['nordklart', 'year-end', companyId ?? 'active', fiscalPeriodId, previewId].join(':')
  const existing = storage.getItem(scope)
  if (existing) return existing
  const created = randomKey()
  storage.setItem(scope, created)
  return created
}
