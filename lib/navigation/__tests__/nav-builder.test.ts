/**
 * Feature-aware navigation matrix: workspace isolation, locked features with
 * upgrade CTA, sandbox unlock, year-end one-time-purchase handling.
 */
import { describe, it, expect } from 'vitest'
import { buildNavGroups, type NavBuilderInput } from '@/lib/navigation/nav-builder'

const ALL_FEATURES = new Set([
  'bookkeeping.core',
  'invoicing.core',
  'reports.core',
  'skatteverket.submissions',
  'year_end.projects',
  'bankgiro.application',
  'bookkeeping.automation',
  'ai.assistant',
])

function companyInput(overrides: Partial<NavBuilderInput> = {}): NavBuilderInput {
  return {
    workspaceType: 'company',
    hasCompany: true,
    canManageAgency: false,
    canManagePlatform: false,
    enabledFeatures: ALL_FEATURES,
    hasYearEndAccess: true,
    ...overrides,
  }
}

function flatItems(input: NavBuilderInput) {
  return buildNavGroups(input).flatMap((group) => group.items)
}

describe('buildNavGroups — workspace isolation', () => {
  it('platform workspace only contains /platform routes', () => {
    const items = flatItems(companyInput({ workspaceType: 'platform', canManagePlatform: true }))
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.href.startsWith('/platform'))).toBe(true)
  })

  it('agency workspace contains agency + shared client routes, no platform routes', () => {
    const items = flatItems(companyInput({ workspaceType: 'agency', canManageAgency: true }))
    expect(items.some((item) => item.href === '/agency')).toBe(true)
    expect(items.some((item) => item.href.startsWith('/platform'))).toBe(false)
  })

  it('company workspace hides agency/platform links for regular users', () => {
    const items = flatItems(companyInput())
    expect(items.some((item) => item.href === '/agency')).toBe(false)
    expect(items.some((item) => item.href === '/platform')).toBe(false)
  })

  it('company workspace shows agency/platform entry points only with the capability', () => {
    const items = flatItems(companyInput({ canManageAgency: true, canManagePlatform: true }))
    expect(items.some((item) => item.href === '/agency')).toBe(true)
    expect(items.some((item) => item.href === '/platform')).toBe(true)
  })
})

describe('buildNavGroups — feature locking', () => {
  it('nothing is locked when every feature is enabled', () => {
    const items = flatItems(companyInput())
    expect(items.filter((item) => item.locked)).toHaveLength(0)
  })

  it('locks invoicing, skatteverket and bankgiro when the features are missing', () => {
    const items = flatItems(companyInput({
      enabledFeatures: new Set(['bookkeeping.core', 'reports.core']),
      hasYearEndAccess: false,
    }))
    const lockedHrefs = items.filter((item) => item.locked).map((item) => item.href)
    expect(lockedHrefs).toContain('/invoices')
    expect(lockedHrefs).toContain('/skatteverket')
    expect(lockedHrefs).toContain('/payments/bankgiro')
    expect(lockedHrefs).toContain('/year-end')
    // Locked items stay visible — they are never removed from the nav.
    expect(items.some((item) => item.href === '/invoices')).toBe(true)
  })


  it('unlocks Bankgiro application navigation before provider operations are ready', () => {
    const items = flatItems(companyInput({
      enabledFeatures: new Set(['bankgiro.application']),
      hasYearEndAccess: false,
    }))
    expect(items.find((item) => item.href === '/payments/bankgiro')?.locked).toBe(false)
  })

  it('a fiscal-period one-time purchase unlocks year-end without the company-wide feature', () => {
    const items = flatItems(companyInput({
      enabledFeatures: new Set(['bookkeeping.core']),
      hasYearEndAccess: true,
    }))
    const yearEnd = items.find((item) => item.href === '/year-end')
    expect(yearEnd?.locked).toBe(false)
  })

  it('fails open when entitlements are unknown (server still enforces)', () => {
    const items = flatItems(companyInput({ enabledFeatures: null, hasYearEndAccess: false }))
    expect(items.filter((item) => item.locked)).toHaveLength(0)
  })

  it('sandbox companies see everything unlocked', () => {
    const items = flatItems(companyInput({
      enabledFeatures: new Set<string>(),
      hasYearEndAccess: false,
      isSandbox: true,
    }))
    expect(items.filter((item) => item.locked)).toHaveLength(0)
  })

  it('carries the feature code so the locked item can deep-link the upgrade CTA', () => {
    const items = flatItems(companyInput({ enabledFeatures: new Set<string>(), hasYearEndAccess: false }))
    const invoices = items.find((item) => item.href === '/invoices')
    expect(invoices?.locked).toBe(true)
    expect(invoices?.feature).toBe('invoicing.core')
  })
})

describe('buildNavGroups — badges', () => {
  it('threads worklist badges onto the right items', () => {
    const items = flatItems(companyInput({
      badges: { pendingOperations: 4, uncategorizedTransactions: 7 },
    }))
    expect(items.find((item) => item.href === '/pending')?.badge).toBe(4)
    expect(items.find((item) => item.href === '/transactions')?.badge).toBe(7)
  })
})
