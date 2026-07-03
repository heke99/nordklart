/**
 * Luhn (modulus 10) check digit calculation and validation utilities.
 * Used for Swedish Bankgiro numbers and OCR payment references.
 *
 * Algorithm source: Bankgirot "Beräkning av kontrollsiffra 10-modulen"
 */

/**
 * Calculate the Luhn check digit for a string of digits.
 * Weights alternate 2,1 starting from the rightmost digit.
 */
export function luhnCheckDigit(digits: string): number {
  let sum = 0
  for (let i = digits.length - 1; i >= 0; i--) {
    const posFromRight = digits.length - 1 - i
    const weight = posFromRight % 2 === 0 ? 2 : 1
    let product = parseInt(digits[i], 10) * weight
    if (product > 9) product -= 9
    sum += product
  }
  return (10 - (sum % 10)) % 10
}

/**
 * Validate that the last digit of a number string is a correct Luhn check digit.
 */
export function luhnValidate(number: string): boolean {
  if (number.length < 2) return false
  const payload = number.slice(0, -1)
  const checkDigit = parseInt(number[number.length - 1], 10)
  return luhnCheckDigit(payload) === checkDigit
}

// -- Bankgiro --

/**
 * Validate a Swedish Bankgiro number (7-8 digits, Luhn check digit).
 * Accepts formats: "XXX-XXXX", "XXXX-XXXX", or raw digits.
 */
export function validateBankgiroNumber(input: string): boolean {
  const digits = input.replace(/[-\s]/g, '')
  if (!/^\d+$/.test(digits)) return false
  if (digits.length !== 7 && digits.length !== 8) return false
  return luhnValidate(digits)
}

/**
 * Format a Bankgiro number with the standard hyphen placement.
 * 7 digits → XXX-XXXX, 8 digits → XXXX-XXXX.
 */
export function formatBankgiroNumber(input: string): string {
  const digits = input.replace(/[-\s]/g, '')
  if (digits.length === 7) return digits.slice(0, 3) + '-' + digits.slice(3)
  if (digits.length === 8) return digits.slice(0, 4) + '-' + digits.slice(4)
  return input
}

// -- OCR reference --

/**
 * Generate a Swedish OCR reference from an invoice number.
 * Strips non-numeric characters and appends a Luhn check digit.
 * Result is 2-25 digits.
 */
export function generateOcrReference(invoiceNumber: string): string {
  const digits = invoiceNumber.replace(/\D/g, '')
  if (digits.length === 0 || digits.length > 24) return invoiceNumber
  const checkDigit = luhnCheckDigit(digits)
  return digits + checkDigit.toString()
}

/**
 * Validate a Swedish OCR reference number (2-25 digits, Luhn check digit).
 */
export function validateOcrReference(ocr: string): boolean {
  if (!/^\d+$/.test(ocr)) return false
  if (ocr.length < 2 || ocr.length > 25) return false
  return luhnValidate(ocr)
}

/**
 * Generate an OCR reference for a CREDIT NOTE.
 *
 * A credit note number like "KR-F2026001" strips to the same digits as the
 * original invoice "F2026001", so the plain generateOcrReference would emit
 * an IDENTICAL OCR for both documents — a payment against the credit note
 * would auto-match the original invoice during bank reconciliation.
 *
 * We prefix the digit 9 to the numeric payload before appending the Luhn
 * check digit, guaranteeing a distinct OCR (regular invoice numbers produce
 * OCR ≤ their own digits; the 9-prefix namespace never collides as long as
 * invoice numbers don't start with 9 followed by another invoice's number —
 * which sequential F-series numbers never do).
 */
export function generateCreditNoteOcrReference(creditNoteNumber: string): string {
  const digits = creditNoteNumber.replace(/\D/g, '')
  if (digits.length === 0 || digits.length > 23) return creditNoteNumber
  const payload = '9' + digits
  const checkDigit = luhnCheckDigit(payload)
  return payload + checkDigit.toString()
}
