import { userHasPassword } from './has-password'

/**
 * MFA (Multi-Factor Authentication) helpers.
 *
 * MFA is only required on the hosted product, never for self-hosted
 * deployments. Enforcement is application-side (middleware + API routes), not
 * RLS.
 */

export function isMfaRequired(): boolean {
  if (process.env.NEXT_PUBLIC_SELF_HOSTED === 'true') return false
  return process.env.NEXT_PUBLIC_REQUIRE_MFA === 'true'
}

/**
 * Check if MFA should be enforced for a specific user.
 *
 * BankID-only accounts skip TOTP because BankID is inherently 2FA and it is
 * the only way into the account.
 *
 * `bankid_linked` alone is NOT enough. `POST /bankid/link` sets that flag on an
 * existing email+password account, and the flag is not a property of the
 * current session — so exempting on it alone let the account keep signing in
 * with a password and no second factor at all. The exemption therefore also
 * requires that the account has no password of its own; the moment the user
 * sets one (`POST /api/account/password` flips `has_password`), the password
 * login path exists again and TOTP is required with it.
 */
export function shouldEnforceMfa(user: { app_metadata?: Record<string, unknown> }): boolean {
  if (!isMfaRequired()) return false
  const appMetadata = user.app_metadata ?? {}
  const bankIdOnly = appMetadata.bankid_linked === true
    && !userHasPassword({ app_metadata: appMetadata })
  if (bankIdOnly) return false
  return true
}
