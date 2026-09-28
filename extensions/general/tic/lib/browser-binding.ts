import crypto from 'node:crypto'

/**
 * Binds a BankID login order to the browser that started it.
 *
 * /bankid/start sets an httpOnly cookie holding an HMAC of the order id;
 * /bankid/complete refuses to mint a session unless the same browser presents
 * it. Without this, anyone who learned an order id (logs, a shared screen, a
 * leaked URL) could complete the login in their own browser once the victim
 * had identified in the BankID app.
 */
export const BANKID_BINDING_COOKIE = 'nordklart-bankid-order'
export const BANKID_BINDING_MAX_AGE_SECONDS = 10 * 60

function bindingKey(): Buffer {
  const dedicated = process.env.BANKID_BINDING_SECRET?.trim()
  const base = dedicated || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!base) throw new Error('BANKID_BINDING_SECRET or SUPABASE_SERVICE_ROLE_KEY is required')
  // Domain-separated so the value is useless for anything else.
  return crypto.createHash('sha256').update(`nordklart:bankid-order-binding:v1:${base}`).digest()
}

export function bankIdBindingValue(sessionRef: string): string {
  return crypto.createHmac('sha256', bindingKey()).update(sessionRef).digest('base64url')
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

export function verifyBankIdBinding(request: Request, sessionRef: string): boolean {
  const presented = readCookie(request, BANKID_BINDING_COOKIE)
  if (!presented) return false
  const expected = bankIdBindingValue(sessionRef)
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
