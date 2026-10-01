/**
 * Terms re-acceptance gate.
 *
 * When the active version of the terms or the privacy policy changes, every
 * signed-in user must accept the new version before using the app. The
 * middleware asks the database (pending_legal_documents) and redirects to
 * LEGAL_ACCEPT_PATH while anything is pending. To avoid that round trip on
 * every navigation, a user who has nothing pending gets a signed httpOnly
 * cookie bound to their user id and the current version; a new version or a
 * different user invalidates it.
 *
 * Edge-safe: Web Crypto only.
 */

export const LEGAL_ACCEPT_PATH = '/villkor/godkann'

/** Bump together with a migration that activates new legal text versions. */
export const CURRENT_LEGAL_VERSION = '2026-10-01'

export const LEGAL_ACK_COOKIE = 'nordklart-legal-ack'

/** Re-check the database at least this often even with a valid cookie. */
export const LEGAL_ACK_MAX_AGE_SECONDS = 12 * 60 * 60

/** Paths a user with pending documents can still open. */
export function isLegalGateExempt(pathname: string): boolean {
  return (
    pathname === LEGAL_ACCEPT_PATH ||
    pathname.startsWith(`${LEGAL_ACCEPT_PATH}/`) ||
    // Declining the terms must leave a way out: account deletion lives here.
    // Signing out is an API route, which the middleware does not gate.
    pathname.startsWith('/settings/account')
  )
}

function gateSecret(): string | null {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY
  return base ? `nordklart-legal-ack:v1:${base}` : null
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Cookie value proving `userId` has accepted CURRENT_LEGAL_VERSION, or null without a secret. */
export async function signLegalAck(userId: string): Promise<string | null> {
  const secret = gateSecret()
  if (!secret) return null
  return `${CURRENT_LEGAL_VERSION}.${await hmacHex(secret, `${userId}:${CURRENT_LEGAL_VERSION}`)}`
}

export async function verifyLegalAck(value: string | undefined, userId: string): Promise<boolean> {
  if (!value) return false
  const expected = await signLegalAck(userId)
  if (!expected || expected.length !== value.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ value.charCodeAt(i)
  return diff === 0
}
