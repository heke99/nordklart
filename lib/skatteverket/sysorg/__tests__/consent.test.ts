/**
 * Sysorg submission consent gate: filing on the customer's behalf requires an
 * active BankID-signed 'skatteverket' consent; the gate fails closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  assertSkatteverketSubmissionConsent,
  hasActiveSkatteverketConsent,
  SkvConsentError,
} from '@/lib/skatteverket/sysorg/consent'

let consentRow: { id: string } | null = null
const filters: Array<{ column: string; value: unknown }> = []

const mockSupabase = {
  from: () => ({
    select: () => ({
      eq(column: string, value: unknown) {
        filters.push({ column, value })
        return this
      },
      limit() {
        return this
      },
      maybeSingle: async () => ({ data: consentRow, error: null }),
    }),
  }),
} as never

describe('assertSkatteverketSubmissionConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    consentRow = null
    filters.length = 0
  })

  it('fails closed without a company context', async () => {
    await expect(assertSkatteverketSubmissionConsent(undefined, 'company-1')).rejects.toThrow(SkvConsentError)
    await expect(assertSkatteverketSubmissionConsent(mockSupabase, null)).rejects.toThrow(SkvConsentError)
  })

  it('throws a clear Swedish error when no active consent exists', async () => {
    await expect(assertSkatteverketSubmissionConsent(mockSupabase, 'company-1')).rejects.toThrow(/samtycke/)
  })

  it('passes with an active skatteverket consent for the company', async () => {
    consentRow = { id: 'consent-1' }
    await expect(assertSkatteverketSubmissionConsent(mockSupabase, 'company-1')).resolves.toBeUndefined()
    expect(filters).toEqual(
      expect.arrayContaining([
        { column: 'company_id', value: 'company-1' },
        { column: 'consent_type', value: 'skatteverket' },
        { column: 'status', value: 'active' },
      ]),
    )
  })

  it('hasActiveSkatteverketConsent returns false on lookup errors (fail closed)', async () => {
    const erroringSupabase = {
      from: () => ({
        select: () => ({
          eq() { return this },
          limit() { return this },
          maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
        }),
      }),
    } as never
    expect(await hasActiveSkatteverketConsent(erroringSupabase, 'company-1')).toBe(false)
  })
})
