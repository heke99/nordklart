import { luhnValidate, validateBankgiroNumber, validateOcrReference } from '@/lib/bankgiro/luhn'
import { isValidPeppolId } from '@/lib/peppol/types'

/**
 * Swedish standard-field validators with clear, solution-oriented Swedish
 * error messages. One uniform result shape so forms and API schemas can
 * share the exact same rules.
 *
 * Complements (does not replace) the existing specialised modules:
 *   - org number / personnummer: lib/salary/personnummer.ts
 *   - bankgiro + OCR Luhn:       lib/bankgiro/luhn.ts
 *   - Peppol id format:          lib/peppol/types.ts
 */

export type SwedishValidationResult = { ok: true } | { ok: false; error_sv: string }

const ok: SwedishValidationResult = { ok: true }
const fail = (error_sv: string): SwedishValidationResult => ({ ok: false, error_sv })

// ── Plusgiro ─────────────────────────────────────────────────────────────────

/**
 * Plusgiro: 2–8 digits where the LAST digit is a Luhn check digit.
 * Standard display format is "XXXXXXX-X" (check digit after the hyphen).
 */
export function validatePlusgiro(input: string): SwedishValidationResult {
  const digits = input.replace(/[-\s]/g, '')
  if (!/^\d+$/.test(digits)) {
    return fail('Plusgironumret får bara innehålla siffror (och ett bindestreck före kontrollsiffran).')
  }
  if (digits.length < 2 || digits.length > 8) {
    return fail('Plusgironumret ska vara 2–8 siffror, t.ex. 12345-6.')
  }
  if (!luhnValidate(digits)) {
    return fail('Kontrollsiffran stämmer inte — kontrollera att plusgironumret är rätt avskrivet.')
  }
  return ok
}

/** Format a Plusgiro number as digits-hyphen-checkdigit ("123456-7"). */
export function formatPlusgiro(input: string): string {
  const digits = input.replace(/[-\s]/g, '')
  if (digits.length < 2 || !/^\d+$/.test(digits)) return input
  return digits.slice(0, -1) + '-' + digits.slice(-1)
}

// ── IBAN (ISO 13616, mod-97) ─────────────────────────────────────────────────

const IBAN_LENGTHS: Record<string, number> = {
  SE: 24, NO: 15, DK: 18, FI: 18, DE: 22, NL: 18, GB: 22, FR: 27,
  ES: 24, IT: 27, BE: 16, AT: 20, CH: 21, PL: 28, EE: 20, LV: 21, LT: 20,
}

/**
 * IBAN validation: structure, country-specific length (for known countries)
 * and the ISO 7064 mod-97 checksum.
 */
export function validateIban(input: string): SwedishValidationResult {
  const iban = input.replace(/\s/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) {
    return fail('IBAN ska börja med landskod och två kontrollsiffror, t.ex. SE45 5000 0000 0583 9825 7466.')
  }
  const country = iban.slice(0, 2)
  const expectedLength = IBAN_LENGTHS[country]
  if (expectedLength && iban.length !== expectedLength) {
    return fail(`Ett IBAN för ${country} ska vara ${expectedLength} tecken (angivet: ${iban.length}).`)
  }
  // mod-97: move the first 4 chars to the end, map letters to 10..35,
  // compute the remainder incrementally (the number exceeds 2^53).
  const rearranged = iban.slice(4) + iban.slice(0, 4)
  let remainder = 0
  for (const char of rearranged) {
    const value = char >= 'A' ? (char.charCodeAt(0) - 55).toString() : char
    for (const digit of value) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97
    }
  }
  if (remainder !== 1) {
    return fail('IBAN-kontrollsiffrorna stämmer inte — kontrollera att numret är rätt avskrivet.')
  }
  return ok
}

// ── BIC (ISO 9362) ───────────────────────────────────────────────────────────

/** BIC/SWIFT: 8 or 11 characters — bank (4 letters), country (2 letters), location (2), optional branch (3). */
export function validateBic(input: string): SwedishValidationResult {
  const bic = input.replace(/\s/g, '').toUpperCase()
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) {
    return fail('BIC ska vara 8 eller 11 tecken, t.ex. NDEASESS eller HANDSESS.')
  }
  return ok
}

// ── Swedish postal code ──────────────────────────────────────────────────────

/** Swedish postal code: 5 digits, first digit 1–9 (accepts "XXX XX"). */
export function validateSwedishPostalCode(input: string): SwedishValidationResult {
  const digits = input.replace(/\s/g, '')
  if (!/^[1-9]\d{4}$/.test(digits)) {
    return fail('Postnumret ska vara fem siffror, t.ex. 114 35.')
  }
  return ok
}

// ── Wrappers over existing modules (uniform result shape) ────────────────────

export function validateBankgiro(input: string): SwedishValidationResult {
  if (!validateBankgiroNumber(input)) {
    return fail('Bankgironumret ska vara 7–8 siffror med korrekt kontrollsiffra, t.ex. 5402-9681.')
  }
  return ok
}

export function validateOcr(input: string): SwedishValidationResult {
  if (!validateOcrReference(input)) {
    return fail('OCR-numret ska vara 2–25 siffror med korrekt kontrollsiffra (Luhn).')
  }
  return ok
}

export function validatePeppolId(input: string): SwedishValidationResult {
  if (!isValidPeppolId(input)) {
    return fail('Peppol-id ska ha formatet schema:id, t.ex. 0007:5567891234 (0007 = svenskt organisationsnummer).')
  }
  return ok
}
