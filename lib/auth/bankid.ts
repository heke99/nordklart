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

/**
 * Legacy plain SHA-256 hash. Personnummer have ~10^10 possible values, so an
 * unkeyed hash is brute-forceable offline if the table leaks. Kept ONLY so
 * existing bankid_identities rows written before the HMAC migration can
 * still be found (dual-read in the TIC login flow, which upgrades rows to
 * the HMAC hash on successful login). Never use for new rows.
 */
export function hashPersonalNumber(personalNumber: string): string {
  return crypto.createHash('sha256').update(personalNumber).digest('hex')
}

function getHashSecret(): string {
  // Server-only secrecy is what defeats offline brute force of the ~10^10
  // personnummer space, so any server-only secret would work cryptographically.
  // STABILITY is the second requirement, and that is why SUPABASE_SERVICE_ROLE_KEY
  // is no longer accepted: it is a credential with its own rotation lifecycle,
  // and rotating it would silently change every hash — orphaning every
  // bankid_identities row, with no error and no way back to the old values.
  // Both remaining sources are dedicated BankID secrets that are only rotated
  // deliberately, with a re-hash.
  const secret = process.env.BANKID_HASH_SECRET || process.env.BANKID_ENCRYPTION_KEY
  if (!secret) {
    throw new Error('BANKID_HASH_SECRET (eller BANKID_ENCRYPTION_KEY) krävs för att hasha personnummer.')
  }
  return secret
}

/** Keyed (HMAC-SHA256) personnummer hash — use for ALL new rows. */
export function hashPersonalNumberHmac(personalNumber: string): string {
  return crypto.createHmac('sha256', getHashSecret()).update(personalNumber).digest('hex')
}

/**
 * All hashes that may identify an existing row for this personnummer, in
 * lookup-priority order: [HMAC (current), SHA-256 (legacy)].
 */
export function personalNumberHashCandidates(personalNumber: string): string[] {
  return [hashPersonalNumberHmac(personalNumber), hashPersonalNumber(personalNumber)]
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
