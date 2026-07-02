import { vi } from 'vitest'

vi.mock('server-only', () => ({}))

// ── Platform feature-policy default-allow for unit tests ────────────────────
//
// `withRouteContext` / `withApiV1` gate protected operations through the
// platform entitlement RPCs (`company_feature_access`,
// `company_commercial_limit`), which are deny-by-default and DB-backed.
// Unit tests exercise route logic against chainable Supabase mocks that don't
// implement those RPCs, so without a default the gate would 403/402 every
// protected route.
//
// Tests that verify the deny path re-mock these modules in their own file,
// which takes precedence over this setup-level registration.
vi.mock('@/lib/platform/entitlements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/entitlements')>()
  return {
    ...actual,
    checkFeatureAccess: vi.fn().mockResolvedValue({ allowed: true }),
    hasCompanyFeature: vi.fn().mockResolvedValue(true),
    listCompanyFeatureAccess: vi.fn().mockResolvedValue([]),
  }
})

vi.mock('@/lib/platform/entitlement-limits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/entitlement-limits')>()
  const allowedLimit = (featureCode: string) => ({
    allowed: true,
    reason: 'within_limit',
    featureCode,
    limitValue: null,
    limitUnit: null,
    usageValue: null,
    remainingValue: null,
  })
  return {
    ...actual,
    getCommercialLimit: vi
      .fn()
      .mockImplementation(async (_supabase: unknown, _companyId: string, featureCode: string) =>
        allowedLimit(featureCode),
      ),
    assertCommercialLimit: vi.fn().mockResolvedValue({ ok: true }),
    assertCurrentUsageWithinCommercialLimit: vi.fn().mockResolvedValue({ ok: true }),
    canInviteCompanyUser: vi.fn().mockResolvedValue(allowedLimit('platform.users_included')),
    canInviteExternalAdvisor: vi.fn().mockResolvedValue(allowedLimit('platform.external_advisor')),
    canAddPayrollEmployee: vi.fn().mockResolvedValue(allowedLimit('salary.employees_included')),
  }
})
