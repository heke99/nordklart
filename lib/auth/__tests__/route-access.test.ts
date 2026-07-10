import { describe, expect, it } from 'vitest'
import { isPublicAuthPath, isPublicMarketingPath } from '../route-access'

describe('route access classification', () => {
  it('keeps all public marketing/legal pages public', () => {
    for (const path of [
      '/',
      '/priser',
      '/prisvillkor',
      '/systemdokumentation',
      '/integritetspolicy',
      '/angerratt',
    ]) {
      expect(isPublicMarketingPath(path)).toBe(true)
      expect(isPublicMarketingPath(`${path === '/' ? '' : path}/`)).toBe(true)
    }
  })

  it('does not classify protected app routes as public marketing pages', () => {
    expect(isPublicMarketingPath('/app')).toBe(false)
    expect(isPublicMarketingPath('/invoices')).toBe(false)
    expect(isPublicMarketingPath('/settings/account')).toBe(false)
  })

  it('keeps login, registration and auth callback routes reachable', () => {
    expect(isPublicAuthPath('/login')).toBe(true)
    expect(isPublicAuthPath('/register')).toBe(true)
    expect(isPublicAuthPath('/auth/callback')).toBe(true)
    expect(isPublicAuthPath('/confirm-email')).toBe(true)
  })

  it('does not classify similarly named protected paths as auth routes', () => {
    expect(isPublicAuthPath('/login-history')).toBe(false)
    expect(isPublicAuthPath('/registration-admin')).toBe(false)
  })
})
