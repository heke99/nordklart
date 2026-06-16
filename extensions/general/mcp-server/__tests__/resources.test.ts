import { describe, it, expect } from 'vitest'
import { dataResources, findResource, parseResourceQuery } from '../resources'

describe('mcp resource registry', () => {
  it('exposes all data resources with required fields', () => {
    expect(dataResources).toHaveLength(7)
    const uris = dataResources.map((r) => r.uri).sort()
    expect(uris).toEqual([
      'Nordklart://attention',
      'Nordklart://capabilities',
      'Nordklart://chart-of-accounts',
      'Nordklart://company/current',
      'Nordklart://period/active',
      'Nordklart://recent-activity',
      'Nordklart://settings/vat-treatments',
    ])

    for (const r of dataResources) {
      expect(r.name).toBeTruthy()
      expect(r.description.length).toBeGreaterThan(20)
      expect(r.mimeType).toBe('application/json')
      expect(typeof r.read).toBe('function')
    }
  })

  it('matches base URI ignoring query string', () => {
    const r = findResource('Nordklart://recent-activity?limit=5')
    expect(r?.uri).toBe('Nordklart://recent-activity')
  })

  it('returns null for unknown URI', () => {
    expect(findResource('Nordklart://does-not-exist')).toBeNull()
  })

  it('parses query params from URI', () => {
    const q = parseResourceQuery('Nordklart://recent-activity?limit=5&offset=10')
    expect(q?.get('limit')).toBe('5')
    expect(q?.get('offset')).toBe('10')
  })

  it('returns undefined when no query', () => {
    expect(parseResourceQuery('Nordklart://capabilities')).toBeUndefined()
  })
})

describe('vat-treatments resource', () => {
  it('returns matrix for all customer types without DB access', async () => {
    const r = findResource('Nordklart://settings/vat-treatments')!
    const result = (await r.read({
      // Pure-function resource: no DB calls
      supabase: undefined as never,
      companyId: 'irrelevant',
      userId: 'irrelevant',
      scopes: [],
    })) as { treatments: string[]; by_customer_type: Record<string, unknown> }

    expect(result.treatments).toContain('standard_25')
    expect(result.treatments).toContain('reverse_charge')
    expect(Object.keys(result.by_customer_type)).toEqual([
      'individual',
      'swedish_business',
      'eu_business',
      'non_eu_business',
    ])
  })
})
