import crypto from 'crypto'
import { createLogger } from '@/lib/logger'

const log = createLogger('provider-token-encryption')

/**
 * At-rest encryption for provider OAuth/API tokens (provider_consent_tokens).
 *
 * Pattern mirrors the Skatteverket token store (AES-256-GCM, dedicated key),
 * adapted for a table that predates encryption:
 *
 *   - Encrypted values carry the `encv1:` prefix (iv ‖ tag ‖ ciphertext,
 *     base64url). Values without the prefix are legacy plaintext rows.
 *   - `decryptProviderToken` transparently handles both shapes, so existing
 *     deployments keep working the moment the key is configured.
 *   - Legacy rows are upgraded in place on the next token write (refresh or
 *     reconnect) — see resolve-consent.ts, which also re-encrypts lazily on
 *     read when it finds a plaintext row and a configured key.
 *
 * Key: PROVIDER_TOKEN_ENCRYPTION_KEY (any string; hashed to 32 bytes).
 * When unset, tokens are stored as before (plaintext) and a warning is
 * logged once — set the key in production.
 */

const PREFIX = 'encv1:'
const ALGORITHM = 'aes-256-gcm'

let warnedMissingKey = false

function getKey(): Buffer | null {
  const key = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true
      log.warn(
        'PROVIDER_TOKEN_ENCRYPTION_KEY is not set — provider tokens are stored unencrypted. Set the key to enable at-rest encryption.',
      )
    }
    return null
  }
  return crypto.createHash('sha256').update(key).digest()
}

export function providerTokenEncryptionConfigured(): boolean {
  return !!process.env.PROVIDER_TOKEN_ENCRYPTION_KEY
}

export function isProviderTokenEncrypted(value: string): boolean {
  return value.startsWith(PREFIX)
}

/** Encrypt a token for storage. Passes through unchanged when no key is set. */
export function encryptProviderToken(plaintext: string): string {
  const key = getKey()
  if (!key) return plaintext
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64url')
}

/**
 * Decrypt a stored token. Legacy plaintext rows (no prefix) pass through
 * unchanged. Throws when an encrypted value cannot be decrypted (missing or
 * rotated key, tampering) — callers should surface "reconnect the provider".
 */
export function decryptProviderToken(value: string): string {
  if (!isProviderTokenEncrypted(value)) return value
  const key = getKey()
  if (!key) {
    throw new Error(
      'Stored provider token is encrypted but PROVIDER_TOKEN_ENCRYPTION_KEY is not configured.',
    )
  }
  const combined = Buffer.from(value.slice(PREFIX.length), 'base64url')
  const iv = combined.subarray(0, 12)
  const tag = combined.subarray(12, 28)
  const encrypted = combined.subarray(28)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}
