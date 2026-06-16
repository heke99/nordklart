import {
  luhnCheckDigit,
  luhnValidate,
  validateBankgiroNumber,
  formatBankgiroNumber,
  generateOcrReference,
  validateOcrReference,
} from '../luhn'

// -- Luhn core --

describe('luhnCheckDigit', () => {
  it('calculates check digit for Bankgiro 991-2346', () => {
    expect(luhnCheckDigit('991234')).toBe(6)
  })

  it('calculates check digit for Bankgiro 5555-5551', () => {
    expect(luhnCheckDigit('5555555')).toBe(1)
  })

  it('returns 0 when sum is already a multiple of 10', () => {
    // 0: weight 2, product 0. Sum=0 → check=0
    expect(luhnCheckDigit('0')).toBe(0)
  })
})

describe('luhnValidate', () => {
  it('validates correct numbers', () => {
    expect(luhnValidate('9912346')).toBe(true)
    expect(luhnValidate('55555551')).toBe(true)
  })

  it('rejects incorrect check digits', () => {
    expect(luhnValidate('9912345')).toBe(false)
    expect(luhnValidate('55555552')).toBe(false)
  })

  it('rejects single-digit input', () => {
    expect(luhnValidate('5')).toBe(false)
  })
})

// -- Bankgiro --

describe('validateBankgiroNumber', () => {
  it('validates 7-digit bankgiro with hyphen', () => {
    expect(validateBankgiroNumber('991-2346')).toBe(true)
  })

  it('validates 8-digit bankgiro with hyphen', () => {
    expect(validateBankgiroNumber('5555-5551')).toBe(true)
  })

  it('validates raw digits without hyphen', () => {
    expect(validateBankgiroNumber('9912346')).toBe(true)
    expect(validateBankgiroNumber('55555551')).toBe(true)
  })

  it('rejects wrong check digit', () => {
    expect(validateBankgiroNumber('991-2345')).toBe(false)
  })

  it('rejects wrong length', () => {
    expect(validateBankgiroNumber('12345')).toBe(false)
    expect(validateBankgiroNumber('123456789')).toBe(false)
  })

  it('rejects non-numeric input', () => {
    expect(validateBankgiroNumber('abc-defg')).toBe(false)
  })

  it('handles spaces', () => {
    expect(validateBankgiroNumber('991 2346')).toBe(true)
  })
})

describe('formatBankgiroNumber', () => {
  it('formats 7-digit as XXX-XXXX', () => {
    expect(formatBankgiroNumber('9912346')).toBe('991-2346')
  })

  it('formats 8-digit as XXXX-XXXX', () => {
    expect(formatBankgiroNumber('55555551')).toBe('5555-5551')
  })

  it('handles already-formatted input', () => {
    expect(formatBankgiroNumber('991-2346')).toBe('991-2346')
  })

  it('returns input unchanged for invalid lengths', () => {
    expect(formatBankgiroNumber('12345')).toBe('12345')
  })
})

// -- OCR reference --

describe('generateOcrReference', () => {
  it('appends correct check digit to numeric invoice number', () => {
    const ocr = generateOcrReference('12345')
    // 12345 → check digit 5 → '123455'
    expect(ocr).toBe('123455')
    expect(validateOcrReference(ocr)).toBe(true)
  })

  it('strips non-numeric characters from invoice number', () => {
    const ocr = generateOcrReference('INV-2024-001')
    // digits: 2024001
    expect(ocr).toBe(generateOcrReference('2024001'))
    expect(validateOcrReference(ocr)).toBe(true)
  })

  it('handles pure-numeric invoice numbers', () => {
    const ocr = generateOcrReference('20240001')
    expect(validateOcrReference(ocr)).toBe(true)
    expect(ocr.length).toBe(9)
  })

  it('returns original if no digits found', () => {
    expect(generateOcrReference('ABC')).toBe('ABC')
  })

  it('returns original if digits exceed 24 characters', () => {
    const long = '1'.repeat(25)
    expect(generateOcrReference(long)).toBe(long)
  })

  it('generates valid OCR for single-digit invoice number', () => {
    const ocr = generateOcrReference('7')
    expect(ocr.length).toBe(2)
    expect(validateOcrReference(ocr)).toBe(true)
  })
})

describe('validateOcrReference', () => {
  it('validates correct OCR', () => {
    expect(validateOcrReference('123455')).toBe(true)
  })

  it('rejects non-numeric', () => {
    expect(validateOcrReference('12345a')).toBe(false)
  })

  it('rejects too short', () => {
    expect(validateOcrReference('5')).toBe(false)
  })

  it('rejects too long (>25 digits)', () => {
    expect(validateOcrReference('1'.repeat(26))).toBe(false)
  })

  it('rejects incorrect check digit', () => {
    expect(validateOcrReference('123459')).toBe(false)
  })
})
