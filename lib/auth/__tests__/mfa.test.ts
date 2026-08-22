import { describe, it, expect, vi, afterEach } from 'vitest'
import { isMfaRequired, shouldEnforceMfa } from '../mfa'

describe('mfa helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('isMfaRequired', () => {
    it('returns false when hosted', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(isMfaRequired()).toBe(false)
    })

    it('returns true when hosted and MFA required', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(isMfaRequired()).toBe(true)
    })
  })

  describe('shouldEnforceMfa', () => {
    it('returns false when MFA is not required', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      expect(shouldEnforceMfa({ app_metadata: {} })).toBe(false)
    })

    it('returns false for a BankID-only account (linked, no password of its own)', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: { bankid_linked: true } })).toBe(false)
      expect(
        shouldEnforceMfa({ app_metadata: { bankid_linked: true, has_password: false } }),
      ).toBe(false)
    })

    // POST /bankid/link sets bankid_linked on an existing email+password
    // account. The flag says nothing about how the *current* session was
    // established, so exempting on it alone left that account signing in with
    // a password and no second factor.
    it('returns true when a password account has merely linked BankID', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(
        shouldEnforceMfa({ app_metadata: { bankid_linked: true, has_password: true } }),
      ).toBe(true)
    })

    it('returns true for a passwordless account that never linked BankID', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: { has_password: false } })).toBe(true)
    })

    it('returns true when MFA required and no bankid', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({ app_metadata: {} })).toBe(true)
    })

    it('returns true when app_metadata is undefined', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_REQUIRE_MFA', 'true')
      expect(shouldEnforceMfa({})).toBe(true)
    })
  })
})
