/**
 * Year-end access resolver: subscriptions cover every period, one-time
 * purchases cover exactly their fiscal_period_id, non-paid purchase statuses
 * grant nothing, platform-admin bypass is explicit and audit-logged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const checkFeatureAccessMock = vi.fn()
vi.mock('@/lib/platform/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/entitlements')>()
  return {
    ...actual,
    checkFeatureAccess: (...args: unknown[]) => checkFeatureAccessMock(...args),
  }
})

// Queryable rows the mock returns per table.
let purchaseRow: Record<string, unknown> | null = null
let platformRoleRow: Record<string, unknown> | null = null
const purchaseFilters: Array<{ column: string; value: unknown }> = []
let purchaseStatusFilter: string[] | null = null
const auditInserts: Array<Record<string, unknown>> = []
let auditInsertError: { message: string } | null = null

function chainFor(table: string) {
  const chain: Record<string, unknown> = {}
  const resolveRow = () => {
    if (table === 'one_time_purchases') return purchaseRow
    if (table === 'platform_roles') return platformRoleRow
    return null
  }
  chain.select = () => chain
  chain.eq = (column: string, value: unknown) => {
    if (table === 'one_time_purchases') purchaseFilters.push({ column, value })
    return chain
  }
  chain.is = () => chain
  chain.in = (_column: string, values: string[]) => {
    if (table === 'one_time_purchases') purchaseStatusFilter = values
    return chain
  }
  chain.order = () => chain
  chain.limit = () => chain
  chain.maybeSingle = async () => ({ data: resolveRow(), error: null })
  chain.insert = (row: Record<string, unknown>) => {
    if (table === 'audit_log') auditInserts.push(row)
    return Promise.resolve({ data: null, error: auditInsertError })
  }
  return chain
}

const mockSupabase = { from: (table: string) => chainFor(table) }

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => mockSupabase,
}))

import { resolveYearEndAccess, requireYearEndAccess } from '@/lib/year-end/access'

describe('resolveYearEndAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    purchaseRow = null
    platformRoleRow = null
    purchaseStatusFilter = null
    purchaseFilters.length = 0
    auditInserts.length = 0
    auditInsertError = null
    checkFeatureAccessMock.mockResolvedValue({ allowed: false, reason: 'missing_entitlement' })
  })

  it('allows any period through a year_end.projects entitlement (subscription)', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'sub-1' })
    const decision = await resolveYearEndAccess(mockSupabase as never, 'company-1', 'period-1')
    expect(decision).toMatchObject({ allowed: true, source: 'feature_entitlement' })
  })

  it('allows the exact purchased fiscal period through a one-time purchase', async () => {
    purchaseRow = { id: 'purchase-1', permanent_access: true, access_expires_at: null }
    const decision = await resolveYearEndAccess(mockSupabase as never, 'company-1', 'period-1')
    expect(decision).toMatchObject({ allowed: true, source: 'one_time_purchase', sourceId: 'purchase-1' })
    // The lookup must be scoped to the exact company + fiscal period.
    expect(purchaseFilters).toEqual(
      expect.arrayContaining([
        { column: 'company_id', value: 'company-1' },
        { column: 'fiscal_period_id', value: 'period-1' },
        { column: 'purchase_type', value: 'year_end' },
      ]),
    )
  })

  it('only accepts paid/active/fulfilled purchase statuses (pending/cancelled/expired grant nothing)', async () => {
    purchaseRow = { id: 'purchase-1', permanent_access: true }
    await resolveYearEndAccess(mockSupabase as never, 'company-1', 'period-1')
    expect(purchaseStatusFilter).toEqual(['paid', 'active', 'fulfilled'])
    expect(purchaseStatusFilter).not.toContain('pending_payment')
    expect(purchaseStatusFilter).not.toContain('cancelled')
    expect(purchaseStatusFilter).not.toContain('expired')
    expect(purchaseStatusFilter).not.toContain('refunded')
  })

  it('denies another period when the purchase is bound elsewhere (no row found)', async () => {
    purchaseRow = null // simulates the exact-period filter finding nothing
    const decision = await resolveYearEndAccess(mockSupabase as never, 'company-1', 'period-OTHER')
    expect(decision).toMatchObject({ allowed: false, reason: 'missing_entitlement' })
  })

  it('denies an expired non-permanent purchase', async () => {
    purchaseRow = { id: 'purchase-1', permanent_access: false, access_expires_at: '2020-01-01T00:00:00Z' }
    const decision = await resolveYearEndAccess(mockSupabase as never, 'company-1', 'period-1')
    expect(decision).toMatchObject({ allowed: false, reason: 'expired' })
  })

  it('denies when no entitlement, purchase or platform role exists', async () => {
    const decision = await resolveYearEndAccess(mockSupabase as never, 'company-1', 'period-1', 'user-1')
    expect(decision).toMatchObject({ allowed: false, reason: 'missing_entitlement' })
  })
})

describe('requireYearEndAccess — platform admin bypass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    purchaseRow = null
    platformRoleRow = { role: 'platform_admin' }
    auditInserts.length = 0
    auditInsertError = null
    checkFeatureAccessMock.mockResolvedValue({ allowed: false, reason: 'missing_entitlement' })
  })

  it('allows a platform admin and writes a durable audit row', async () => {
    const decision = await requireYearEndAccess(mockSupabase as never, 'company-1', 'admin-1', 'period-1', {
      operation: 'period.year_end',
      requestId: 'req-1',
    })
    expect(decision).toMatchObject({ allowed: true, source: 'platform_admin_bypass' })
    expect(auditInserts).toHaveLength(1)
    expect(auditInserts[0]).toMatchObject({
      action: 'SECURITY_EVENT',
      record_id: 'period-1',
      new_state: expect.objectContaining({
        company_id: 'company-1',
        access_source: 'platform_admin_bypass',
        operation: 'period.year_end',
        request_id: 'req-1',
      }),
    })
  })

  it('still allows the admin when the audit sink fails, but never silently', async () => {
    auditInsertError = { message: 'rls denied' }
    const decision = await requireYearEndAccess(mockSupabase as never, 'company-1', 'admin-1', 'period-1')
    expect(decision.allowed).toBe(true)
  })

  it('does not audit when access came from an entitlement', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: true, sourceId: 'sub-1' })
    await requireYearEndAccess(mockSupabase as never, 'company-1', 'user-1', 'period-1')
    expect(auditInserts).toHaveLength(0)
  })
})
