import { describe, it, expect } from 'vitest'
import { extractLocalPartForDomain } from '@/extensions/general/invoice-inbox/lib/resend-inbound'

describe('extractLocalPartForDomain', () => {
  it('returns the local part when a recipient matches the domain', () => {
    const result = extractLocalPartForDomain(
      ['acme-ab-x7f2@nordklart.io', 'billing@acme.se'],
      'nordklart.io'
    )
    expect(result).toBe('acme-ab-x7f2')
  })

  it('lowercases the local part and matches domain case-insensitively', () => {
    const result = extractLocalPartForDomain(
      ['ACME-AB-X7F2@NORDKLART.SE'],
      'nordklart.io'
    )
    expect(result).toBe('acme-ab-x7f2')
  })

  it('returns null when no recipient matches', () => {
    const result = extractLocalPartForDomain(
      ['billing@acme.se', 'invoices@contoso.com'],
      'nordklart.io'
    )
    expect(result).toBeNull()
  })

  it('returns null for malformed addresses', () => {
    const result = extractLocalPartForDomain(
      ['not-an-email', '@nordklart.io', 'foo@'],
      'nordklart.io'
    )
    expect(result).toBeNull()
  })

  it('returns the first matching recipient when multiple match', () => {
    const result = extractLocalPartForDomain(
      ['first-abcd@nordklart.io', 'second-efgh@nordklart.io'],
      'nordklart.io'
    )
    expect(result).toBe('first-abcd')
  })

  it('trims whitespace inside candidate addresses', () => {
    const result = extractLocalPartForDomain(
      ['  acme-xxx@nordklart.io  '],
      'nordklart.io'
    )
    expect(result).toBe('acme-xxx')
  })
})
