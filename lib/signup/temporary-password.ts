import 'server-only'

import { randomBytes } from 'crypto'

/**
 * Creates an unusable bootstrap credential for an email-confirmation signup.
 * It is generated only on the server, never persisted by Nordklart and never
 * returned to the browser. The verified user replaces it on the activation
 * page before a normal password login is possible.
 */
export function createTemporarySignupPassword(): string {
  return `${randomBytes(32).toString('base64url')}Aa1!`
}
