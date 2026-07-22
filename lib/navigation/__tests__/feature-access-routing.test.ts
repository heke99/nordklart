import { describe, expect, it } from 'vitest'
import {
  featureForDashboardPath,
  purchaseFocusForFeature,
  purchaseHrefForFeature,
} from '@/lib/navigation/feature-access-routing'

describe('featureForDashboardPath', () => {
  it('maps commercial dashboard routes to the canonical feature', () => {
    expect(featureForDashboardPath('/transactions/abc')).toBe('bookkeeping.core')
    expect(featureForDashboardPath('/bookkeeping/year-end/arsredovisning')).toBe('year_end.projects')
    expect(featureForDashboardPath('/invoices/new')).toBe('invoicing.core')
    expect(featureForDashboardPath('/payments/bankgiro')).toBe('bankgiro.application')
    expect(featureForDashboardPath('/automation')).toBe('bookkeeping.automation')
    expect(featureForDashboardPath('/chat')).toBe('ai.assistant')
  })

  it('does not gate account/settings/core worklist routes', () => {
    expect(featureForDashboardPath('/settings/company')).toBeNull()
    expect(featureForDashboardPath('/pending')).toBeNull()
    expect(featureForDashboardPath('/app')).toBeNull()
  })
})

describe('purchase routing', () => {
  it('routes bankgiro and year-end to their own sections', () => {
    expect(purchaseFocusForFeature('bankgiro.application')).toBe('bankgiro')
    expect(purchaseFocusForFeature('year_end.projects')).toBe('year-end')
    expect(purchaseFocusForFeature('invoicing.core')).toBe('plans')
  })

  it('preserves the requested feature and safe return path', () => {
    expect(purchaseHrefForFeature('invoicing.core', '/invoices/new')).toBe(
      '/settings/billing?feature=invoicing.core&return_to=%2Finvoices%2Fnew#plans',
    )
  })
})
