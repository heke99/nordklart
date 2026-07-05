/**
 * Parity guards between the three v1 surfaces that must never drift:
 *
 *   1. The endpoint registry (registerEndpoint in every route file) —
 *      drives OpenAPI and the reference docs.
 *   2. V1_ENDPOINT_SCOPES in lib/auth/scopes.ts — the fail-closed runtime
 *      scope map (unmapped routes 404).
 *   3. The reference-doc resource matchers in lib/docs/content/reference.ts —
 *      endpoints that fail classification silently vanish from the docs.
 */
import { describe, expect, it } from 'vitest'
import { listEndpoints } from '@/lib/api/v1/registry'
import { resolveRequiredScope } from '@/lib/auth/scopes'
import { buildResourcePages } from '@/lib/docs/content/reference'
import '@/lib/api/v1/load-routes'

// Endpoints deliberately absent from resource reference pages (documented
// elsewhere: landing/discovery pages).
const REFERENCE_PAGE_EXEMPT = new Set(['GET /api/v1/health'])

/** Convert a registry pattern (:param) to a concrete URL for scope matching. */
function concretize(path: string): string {
  return path.replace(/:([A-Za-z_]+)/g, '00000000-0000-4000-8000-000000000000')
}

describe('v1 scope map ⇄ endpoint registry parity', () => {
  it('every registered endpoint resolves to a scope in V1_ENDPOINT_SCOPES', () => {
    const unmapped: string[] = []
    for (const ep of listEndpoints()) {
      const resolved = resolveRequiredScope(ep.method, concretize(ep.path))
      if (resolved === null) {
        unmapped.push(`${ep.method} ${ep.path}`)
      }
    }
    expect(unmapped).toEqual([])
  })

  it('the scope declared in the registry matches the runtime scope map', () => {
    const mismatches: string[] = []
    for (const ep of listEndpoints()) {
      const resolved = resolveRequiredScope(ep.method, concretize(ep.path))
      const declared = ep.scope ?? 'public'
      if (resolved !== null && resolved !== declared) {
        mismatches.push(`${ep.method} ${ep.path}: registry=${declared} runtime=${resolved}`)
      }
    }
    expect(mismatches).toEqual([])
  })
})

describe('v1 reference docs cover every registered endpoint', () => {
  it('no endpoint silently drops out of the resource pages', () => {
    const pages = buildResourcePages()
    const documented = new Set(
      pages.flatMap((page) => page.endpoints.map((ep) => `${ep.method} ${ep.path}`)),
    )

    const missing: string[] = []
    for (const ep of listEndpoints()) {
      const key = `${ep.method} ${ep.path}`
      if (!documented.has(key) && !REFERENCE_PAGE_EXEMPT.has(key)) {
        missing.push(key)
      }
    }
    expect(missing).toEqual([])
  })
})
