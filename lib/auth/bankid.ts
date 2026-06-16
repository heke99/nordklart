/**
 * BankID authentication helpers.
 *
 * BankID is only available on the hosted deployment (requires TIC Identity API).
 * Self-hosted deployments never show the BankID option.
 */

import crypto from 'crypto'

const ALGORITHM = 'aes-256-gcm'

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

export function isBankIdEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_SELF_HOSTED === 'true') return false
  return process.env.NEXT_PUBLIC_BANKID_ENABLED === 'true'
}

// ---------------------------------------------------------------------------
// Personnummer hashing (for lookup)
// ---------------------------------------------------------------------------

/** SHA-256 hash of a personnummer for fast DB lookup. */
export function hashPersonalNumber(personalNumber: string): string {
  return crypto.createHash('sha256').update(personalNumber).digest('hex')
}

// ---------------------------------------------------------------------------
// Personnummer encryption (for display in settings)
// ---------------------------------------------------------------------------

function getEncryptionKey(): Buffer {
  const key = process.env.BANKID_ENCRYPTION_KEY
  if (!key) throw new Error('BANKID_ENCRYPTION_KEY is required for BankID operations')
  return Buffer.from(key, 'hex')
}

/** AES-256-GCM encrypt a personnummer for storage. */
export function encryptPersonalNumber(personalNumber: string): Buffer {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(personalNumber, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // Format: iv (12) + tag (16) + ciphertext
  return Buffer.concat([iv, tag, encrypted])
}

/** AES-256-GCM decrypt a stored personnummer. */
export function decryptPersonalNumber(data: Buffer): string {
  const key = getEncryptionKey()

  const iv = data.subarray(0, 12)
  const tag = data.subarray(12, 28)
  const encrypted = data.subarray(28)

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Mask a personnummer for display: "XXXXXXXX-1234" */
export function maskPersonalNumber(personalNumber: string): string {
  if (personalNumber.length < 4) return '****'
  const last4 = personalNumber.slice(-4)
  const masked = personalNumber.length === 12 ? 'XXXXXXXX' : 'XXXXXX'
  return `${masked}-${last4}`
}
