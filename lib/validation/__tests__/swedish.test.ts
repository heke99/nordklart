import { describe, it, expect } from 'vitest'
import {
  validatePlusgiro,
  formatPlusgiro,
  validateIban,
  validateBic,
  validateSwedishPostalCode,
  validateBankgiro,
  validateOcr,
  validatePeppolId,
} from '../swedish'

describe('validatePlusgiro', () => {
  it('accepts valid numbers with and without hyphen', () => {
    // 4158-2: payload 4158 → Luhn check digit 2. 90020-9: PlusGirot's own
    // donation account format example.
    expect(validatePlusgiro('41582').ok).toBe(true)
    expect(validatePlusgiro('4158-2').ok).toBe(true)
    expect(validatePlusgiro('90020-9').ok).toBe(true)
  })

  it('rejects wrong check digit, wrong length and non-digits', () => {
    expect(validatePlusgiro('4158-7').ok).toBe(false)
    expect(validatePlusgiro('1').ok).toBe(false)
    expect(validatePlusgiro('123456789').ok).toBe(false)
    expect(validatePlusgiro('12ab-5').ok).toBe(false)
  })

  it('formats digits-hyphen-checkdigit', () => {
    expect(formatPlusgiro('41582')).toBe('4158-2')
  })
})

describe('validateIban', () => {
  it('accepts a valid Swedish IBAN (mod-97)', () => {
    expect(validateIban('SE45 5000 0000 0583 9825 7466').ok).toBe(true)
    expect(validateIban('se4550000000058398257466').ok).toBe(true)
  })

  it('accepts valid foreign IBANs', () => {
    expect(validateIban('DE89 3704 0044 0532 0130 00').ok).toBe(true)
    expect(validateIban('GB29 NWBK 6016 1331 9268 19').ok).toBe(true)
  })

  it('rejects wrong checksum, wrong length and garbage', () => {
    const wrongChecksum = validateIban('SE45 5000 0000 0583 9825 7467')
    expect(wrongChecksum.ok).toBe(false)
    if (!wrongChecksum.ok) expect(wrongChecksum.error_sv).toMatch(/kontrollsiffror/i)

    const wrongLength = validateIban('SE45 5000 0000 0583 9825 74')
    expect(wrongLength.ok).toBe(false)
    if (!wrongLength.ok) expect(wrongLength.error_sv).toMatch(/24 tecken/)

    expect(validateIban('not-an-iban').ok).toBe(false)
  })
})

describe('validateBic', () => {
  it('accepts 8- and 11-character BICs', () => {
    expect(validateBic('NDEASESS').ok).toBe(true)
    expect(validateBic('HANDSESS').ok).toBe(true)
    expect(validateBic('NDEASESSXXX').ok).toBe(true)
  })

  it('rejects malformed BICs', () => {
    expect(validateBic('NDEA').ok).toBe(false)
    expect(validateBic('12345678').ok).toBe(false)
    expect(validateBic('NDEASESSXX').ok).toBe(false)
  })
})

describe('validateSwedishPostalCode', () => {
  it('accepts five digits with or without space', () => {
    expect(validateSwedishPostalCode('114 35').ok).toBe(true)
    expect(validateSwedishPostalCode('11435').ok).toBe(true)
  })

  it('rejects wrong lengths and leading zero', () => {
    expect(validateSwedishPostalCode('1143').ok).toBe(false)
    expect(validateSwedishPostalCode('01435').ok).toBe(false)
    expect(validateSwedishPostalCode('abcde').ok).toBe(false)
  })
})

describe('wrappers', () => {
  it('bankgiro wrapper delegates to Luhn validation', () => {
    expect(validateBankgiro('5402-9681').ok).toBe(true)
    expect(validateBankgiro('5402-9682').ok).toBe(false)
  })

  it('OCR wrapper delegates to Luhn validation', () => {
    // 12345 → check digit 5? compute: generateOcrReference not used; use known pair 1230 → Luhn of 123 = 0.
    expect(validateOcr('1230').ok).toBe(true)
    expect(validateOcr('1231').ok).toBe(false)
  })

  it('Peppol wrapper validates scheme:id', () => {
    expect(validatePeppolId('0007:5567891234').ok).toBe(true)
    expect(validatePeppolId('nonsense').ok).toBe(false)
  })

  it('all error messages are Swedish and solution-oriented', () => {
    const failures = [
      validatePlusgiro('99'),
      validateIban('XX'),
      validateBic('X'),
      validateSwedishPostalCode('1'),
      validateBankgiro('1'),
      validateOcr('1'),
      validatePeppolId('x'),
    ]
    for (const result of failures) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error_sv).toMatch(/t\.ex\.|kontroll|siffror|format/i)
    }
  })
})
