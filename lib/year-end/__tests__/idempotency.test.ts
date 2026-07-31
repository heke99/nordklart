import { describe, expect, it } from 'vitest'
import { getOrCreateYearEndExecutionKey } from '@/lib/year-end/idempotency'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  }
}

describe('getOrCreateYearEndExecutionKey', () => {
  it('keeps the same key for retries of the same company, period and preview', () => {
    const storage = memoryStorage()
    const first = getOrCreateYearEndExecutionKey(storage, 'company-1', 'period-1', 'preview-1')
    const retry = getOrCreateYearEndExecutionKey(storage, 'company-1', 'period-1', 'preview-1')
    expect(retry).toBe(first)
  })

  it('creates a new key when the preview changes', () => {
    const storage = memoryStorage()
    const first = getOrCreateYearEndExecutionKey(storage, 'company-1', 'period-1', 'preview-1')
    const next = getOrCreateYearEndExecutionKey(storage, 'company-1', 'period-1', 'preview-2')
    expect(next).not.toBe(first)
  })
})
