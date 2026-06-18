import { describe, expect, it } from 'vitest'
import {
  defaultRedirectForAuthFlow,
  resolveAuthCallbackFlow,
  safeAuthRedirectPath,
} from '@/lib/auth/auth-callback'

describe('auth callback helpers', () => {
  it('classifies token-hash email confirmation as signup', () => {
    expect(resolveAuthCallbackFlow({ type: 'email', flow: 'signup' })).toBe('signup')
  })

  it('lets recovery type override a manipulated flow query', () => {
    expect(resolveAuthCallbackFlow({ type: 'recovery', flow: 'signup' })).toBe('recovery')
  })

  it('allows known internal destinations only', () => {
    expect(safeAuthRedirectPath('/onboarding?step=company', '/app')).toBe('/onboarding?step=company')
    expect(safeAuthRedirectPath('https://attacker.example', '/app')).toBe('/app')
    expect(safeAuthRedirectPath('//attacker.example', '/app')).toBe('/app')
    expect(safeAuthRedirectPath('/api/private', '/app')).toBe('/app')
  })
  it('sends confirmed signup users to password creation, never onboarding', () => {
    expect(defaultRedirectForAuthFlow('signup')).toBe('/account/set-password?mode=signup')
    expect(safeAuthRedirectPath('/account/set-password?mode=signup', '/app')).toBe('/account/set-password?mode=signup')
  })

})
