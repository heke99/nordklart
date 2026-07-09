/**
 * Uniform commercial + RBAC guards over the Skatteverket extension routes:
 *  - filing routes require the skatteverket.submissions feature
 *  - mutating routes require a write-capable company role (viewer blocked)
 *  - status/disconnect stay reachable without the feature
 *  - upstream Skatteverket response bodies are never forwarded to users
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

const getTokensMock = vi.fn()
vi.mock('../lib/token-store', () => ({
  getTokens: (...args: unknown[]) => getTokensMock(...args),
  storeTokens: vi.fn(),
  deleteTokens: vi.fn(),
}))

import { skatteverketExtension } from '../index'
import type { ExtensionContext } from '@/lib/extensions/types'

function findRoute(method: string, path: string) {
  const route = skatteverketExtension.apiRoutes?.find((r) => r.method === method && r.path === path)
  if (!route) throw new Error(`route not found: ${method} ${path}`)
  return route
}

function makeCtx(memberRole: string | null = 'owner'): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    supabase: {
      from: (table: string) => ({
        select() { return this },
        eq() { return this },
        maybeSingle: async () => ({
          data: table === 'company_members' && memberRole ? { role: memberRole } : null,
          error: null,
        }),
        single: async () => ({ data: null, error: null }),
      }),
    },
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    storage: {},
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    services: {},
  } as unknown as ExtensionContext
}

describe('skatteverket extension guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkFeatureAccessMock.mockResolvedValue({ allowed: true })
    getTokensMock.mockResolvedValue(null)
  })

  it('blocks filing routes without the skatteverket.submissions feature', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: false, reason: 'missing_entitlement' })

    for (const [method, path] of [
      ['GET', '/authorize'],
      ['POST', '/declaration/validate'],
      ['POST', '/agi/submit'],
      ['POST', '/skattekonto/sync'],
    ] as const) {
      const route = findRoute(method, path)
      const response = await route.handler(new Request(`http://localhost/api/x${path}`), makeCtx())
      expect(response.status, `${method} ${path}`).toBe(403)
      const body = await response.json()
      expect(body.error).toBe('FEATURE_NOT_ENABLED')
    }
    expect(checkFeatureAccessMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'skatteverket.submissions')
  })

  it('keeps status and disconnect reachable without the feature', async () => {
    checkFeatureAccessMock.mockResolvedValue({ allowed: false, reason: 'missing_entitlement' })

    const status = findRoute('GET', '/status')
    const response = await status.handler(new Request('http://localhost/api/x/status'), makeCtx())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.connected).toBe(false)
    // Status is company-scoped — the lookup passes the active company id.
    expect(getTokensMock).toHaveBeenCalledWith(expect.anything(), 'user-1', 'company-1')
  })

  it('blocks viewers from mutating routes even with the feature enabled', async () => {
    const route = findRoute('POST', '/declaration/validate')
    const response = await route.handler(
      new Request('http://localhost/api/x/declaration/validate', { method: 'POST' }),
      makeCtx('viewer'),
    )
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error).toContain('behörighet')
  })

  it('never forwards raw Skatteverket response bodies to users', async () => {
    const fs = await import('node:fs')
    const source = fs.readFileSync('extensions/general/skatteverket/index.ts', 'utf8')
    expect(source).not.toContain('Skatteverket svarade med ${')
    expect(source).toContain('sanitizeSkvUpstreamError')
  })
})
