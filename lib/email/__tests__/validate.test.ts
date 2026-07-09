import { describe, it, expect } from 'vitest'
import { isValidEmailAddress } from '@/lib/email/validate'

describe('isValidEmailAddress', () => {
  it('accepts normal addresses', () => {
    expect(isValidEmailAddress('kund@example.se')).toBe(true)
    expect(isValidEmailAddress('anna.lindberg+fakturor@foretag.co.uk')).toBe(true)
  })

  it('rejects empty, null and non-strings', () => {
    expect(isValidEmailAddress('')).toBe(false)
    expect(isValidEmailAddress('   ')).toBe(false)
    expect(isValidEmailAddress(null)).toBe(false)
    expect(isValidEmailAddress(undefined)).toBe(false)
    expect(isValidEmailAddress(42)).toBe(false)
  })

  it('rejects malformed addresses', () => {
    expect(isValidEmailAddress('inte-en-mejl')).toBe(false)
    expect(isValidEmailAddress('a@b')).toBe(false)
    expect(isValidEmailAddress('@example.se')).toBe(false)
    expect(isValidEmailAddress('kund@')).toBe(false)
    expect(isValidEmailAddress('kund @example.se')).toBe(false)
  })

  it('rejects header-injection vectors (CR/LF, control chars)', () => {
    expect(isValidEmailAddress('kund@example.se\r\nBcc: attacker@evil.se')).toBe(false)
    expect(isValidEmailAddress('kund@example.se\nX-Injected: 1')).toBe(false)
    expect(isValidEmailAddress('kund\u0000@example.se')).toBe(false)
  })

  it('rejects absurdly long addresses', () => {
    expect(isValidEmailAddress(`${'a'.repeat(320)}@example.se`)).toBe(false)
  })
})
