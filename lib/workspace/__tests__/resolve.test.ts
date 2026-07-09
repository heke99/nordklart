/**
 * Workspace-type resolution: the URL wins over the saved preference so the
 * sidebar always matches the content on screen.
 */
import { describe, it, expect } from 'vitest'
import { resolveWorkspaceType } from '@/lib/workspace/resolve'

const base = { canManagePlatform: true, canManageAgency: true }

describe('resolveWorkspaceType', () => {
  it('resolves platform for /platform routes when the user has the role', () => {
    expect(resolveWorkspaceType({ pathname: '/platform', preferredWorkspaceType: null, ...base })).toBe('platform')
    expect(resolveWorkspaceType({ pathname: '/platform/price-plans', preferredWorkspaceType: 'company', ...base })).toBe('platform')
  })

  it('never resolves platform without the capability, even on /platform URLs', () => {
    expect(resolveWorkspaceType({
      pathname: '/platform', preferredWorkspaceType: 'platform',
      canManagePlatform: false, canManageAgency: false,
    })).toBe('company')
  })

  it('resolves agency for /agency routes only with agency membership', () => {
    expect(resolveWorkspaceType({ pathname: '/agency/clients', preferredWorkspaceType: null, ...base })).toBe('agency')
    expect(resolveWorkspaceType({
      pathname: '/agency', preferredWorkspaceType: 'agency',
      canManagePlatform: false, canManageAgency: false,
    })).toBe('company')
  })

  it('forces the company workspace on company-only routes despite a platform preference', () => {
    // The bug this guards against: a saved platform/agency preference used to
    // render the platform sidebar while the user was on /app.
    for (const pathname of ['/app', '/invoices', '/invoices/recurring/abc', '/transactions', '/bookkeeping', '/skatteverket']) {
      expect(resolveWorkspaceType({ pathname, preferredWorkspaceType: 'platform', ...base })).toBe('company')
      expect(resolveWorkspaceType({ pathname, preferredWorkspaceType: 'agency', ...base })).toBe('company')
    }
  })

  it('honours the preference on shared review routes', () => {
    expect(resolveWorkspaceType({ pathname: '/pending', preferredWorkspaceType: 'agency', ...base })).toBe('agency')
    expect(resolveWorkspaceType({ pathname: '/year-end', preferredWorkspaceType: 'agency', ...base })).toBe('agency')
    expect(resolveWorkspaceType({ pathname: '/reports', preferredWorkspaceType: 'platform', ...base })).toBe('platform')
    expect(resolveWorkspaceType({ pathname: '/pending', preferredWorkspaceType: null, ...base })).toBe('company')
  })

  it('ignores a preference the user is not entitled to', () => {
    expect(resolveWorkspaceType({
      pathname: '/pending', preferredWorkspaceType: 'platform',
      canManagePlatform: false, canManageAgency: true,
    })).toBe('company')
  })
})
