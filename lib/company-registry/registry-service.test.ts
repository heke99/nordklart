import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { diffRegistryAgainstSettings, normalizedDataFromLookup, publicLookupPayload } from './registry-service'
import type { CompanyRegistryLookup } from './provider'

const lookup: CompanyRegistryLookup = {
  organizationNumber: '5594167149',
  companyName: 'Testbolaget AB',
  legalForm: 'aktiebolag',
  registryStatus: 'active',
  address: { street: 'Testgatan 1', postalCode: '12345', city: 'Stockholm' },
  sniCodes: [{ code: '62010', name: 'Dataprogrammering' }],
  retrievedAt: '2026-06-22T12:00:00.000Z',
  sourcePayload: {
    provider: 'bolagsverket_vardefulla_datamangder',
    raw: { large: true },
    normalized: { business_description: 'Programutveckling' },
  },
}

describe('company registry service', () => {
  it('keeps public lookup payload compact and excludes raw source payload', () => {
    const payload = publicLookupPayload(lookup)
    expect(payload.companyName).toBe('Testbolaget AB')
    expect('sourcePayload' in payload).toBe(false)
  })

  it('normalizes Bolagsverket data into settings-friendly fields', () => {
    const normalized = normalizedDataFromLookup(lookup)
    expect(normalized.company_name).toBe('Testbolaget AB')
    expect(normalized.address_line1).toBe('Testgatan 1')
    expect(normalized.business_description).toBe('Programutveckling')
  })

  it('builds safe diff rows against current company settings', () => {
    const diff = diffRegistryAgainstSettings(normalizedDataFromLookup(lookup), {
      company_name: 'Gammalt namn AB',
      address_line1: 'Testgatan 1',
      postal_code: '12345',
      city: 'Göteborg',
    })

    expect(diff.map((row) => row.field)).toEqual(['company_name', 'city'])
  })
})
