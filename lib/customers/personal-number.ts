import 'server-only'
import {
  decryptPersonnummer,
  encryptPersonnummer,
  extractLast4,
} from '@/lib/salary/personnummer'

/**
 * Customer personnummer, encrypted at rest.
 *
 * A private customer's personnummer is needed for ROT/RUT invoicing. It is the
 * same data class as an employee's, so it uses the same key
 * (PERSONNUMMER_ENCRYPTION_KEY) and the same AES-256-GCM helpers rather than a
 * second scheme with its own rotation story.
 *
 * `personal_number_last4` exists so lists, search and CSV can identify a
 * customer without any surface ever handling the full number. Only the single-
 * customer read decrypts, and only so the edit form can round-trip the value
 * the user themselves entered.
 */

export interface CustomerPersonalNumberColumns {
  personal_number_enc: string | null
  personal_number_last4: string | null
}

/** Columns to write for a customer's personnummer. `null` clears it. */
export function personalNumberColumns(
  personalNumber: string | null | undefined,
): CustomerPersonalNumberColumns {
  const trimmed = personalNumber?.trim()
  if (!trimmed) {
    return { personal_number_enc: null, personal_number_last4: null }
  }
  return {
    personal_number_enc: encryptPersonnummer(trimmed),
    personal_number_last4: extractLast4(trimmed),
  }
}

/**
 * Decrypt for the one surface that needs the full number back: the edit form.
 *
 * Never throws on bad ciphertext — a customer row that cannot be decrypted (key
 * rotated without a re-encrypt) must still render, with the number blank,
 * rather than taking the whole customer page down.
 */
export function readPersonalNumber(
  row: Partial<CustomerPersonalNumberColumns> | null | undefined,
): string | null {
  const cipher = row?.personal_number_enc
  if (!cipher) return null
  try {
    return decryptPersonnummer(cipher)
  } catch {
    return null
  }
}

/**
 * Strip the ciphertext from a row before it leaves the server, replacing it
 * with the masked form. Use on every list/collection response — nothing that
 * renders many customers has a reason to hold any of their personnummer.
 */
export function maskCustomerRow<T extends Partial<CustomerPersonalNumberColumns>>(
  row: T,
): Omit<T, 'personal_number_enc'> & { personal_number: null; personal_number_masked: string | null } {
  const { personal_number_enc: _enc, ...rest } = row
  const last4 = row.personal_number_last4 ?? null
  return {
    ...rest,
    personal_number: null,
    personal_number_masked: last4 ? `XXXXXX-${last4}` : null,
  }
}

/** Hydrate a single row for the edit form: full number in, ciphertext out. */
export function hydrateCustomerRow<T extends Partial<CustomerPersonalNumberColumns>>(
  row: T,
): Omit<T, 'personal_number_enc'> & { personal_number: string | null } {
  const { personal_number_enc: _enc, ...rest } = row
  return { ...rest, personal_number: readPersonalNumber(row) }
}
