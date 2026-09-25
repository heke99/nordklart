import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  setActiveCompany: vi.fn().mockResolvedValue(undefined),
}))

const mockVerifyFounder = vi.fn()
vi.mock('@/lib/company/verify-signatory', () => ({
  verifyFounder: (...args: unknown[]) => mockVerifyFounder(...args),
}))

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { createCompanyFromOnboarding } from '../actions'

const mockCreateClient = vi.mocked(createClient)
const mockCreateServiceClient = vi.mocked(createServiceClient)

type CapturedCall = { table: string; method: string; args: unknown[] }

/**
 * Builds a chainable Supabase mock that records every method call, allows
 * per-table result seeding, and returns a capture log the test can assert on.
 *
 * - `results[table][method]` (optional) is returned when the chain ends on
 *   that method. Chains otherwise resolve to `{ data: null, error: null }`.
 * - Unknown methods on the chain no-op and return the chain so callers can
 *   keep chaining freely.
 */
function buildSupabase(opts: {
  user: { id: string } | null
  results?: Record<string, Record<string, { data?: unknown; error?: unknown }>>
  rpcResults?: Record<string, { data?: unknown; error?: unknown }>
}) {
  const calls: CapturedCall[] = []
  const { user, results = {}, rpcResults = {} } = opts

  function makeChain(table: string) {
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
    }
    const chain: Record<string, unknown> = {}
    const methods = ['select', 'eq', 'is', 'in', 'order', 'limit', 'maybeSingle', 'single', 'insert', 'upsert', 'delete', 'update']
    for (const m of methods) {
      chain[m] = (...args: unknown[]) => {
        record(m, args)
        const canTerminate = results[table]?.[m]
        if (canTerminate) {
          return Promise.resolve({
            data: canTerminate.data ?? null,
            error: canTerminate.error ?? null,
          })
        }
        return chain
      }
    }
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
    return chain
  }

  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn().mockImplementation((table: string) => makeChain(table)),
    rpc: vi.fn().mockImplementation((name: string) => {
      const result = rpcResults[name]
      if (result) {
        return Promise.resolve({ data: result.data ?? null, error: result.error ?? null })
      }
      return Promise.resolve({ data: null, error: null })
    }),
  }

  return { supabase, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockVerifyFounder.mockResolvedValue({ kind: 'decided', status: 'verified', reason: 'ab_registered_representative', evidence: {} })
})

describe('createCompanyFromOnboarding — org_number validation', () => {
  it('rejects malformed org_numbers at the guard boundary', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_with_owner: { data: 'x' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockCreateServiceClient.mockReturnValue(supabase as never)

    const result = await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Broken AB',
        org_number: 'abc123', // not a 10- or 12-digit number
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
    })

    expect(result.error).toBe('org_number_invalid')
    // Must NOT have reached the create RPC — otherwise we'd save a malformed
    // org_number and poison SIE/SRU exports.
    const rpcCreate = supabase.rpc.mock.calls.find(([name]) => name === 'create_company_for_founder')
    expect(rpcCreate).toBeUndefined()
  })

  it('rejects right-length org_numbers with invalid Luhn check digit', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_with_owner: { data: 'x' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockCreateServiceClient.mockReturnValue(supabase as never)

    const result = await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Fake AB',
        // 10 digits but Luhn check digit is wrong (real Volvo is 5560125790;
        // the trailing 1 is an intentional off-by-one). Skatteverket SRU
        // validators and receiving SIE4 consumers would reject this, so we
        // refuse at the boundary.
        org_number: '5560125791',
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
    })

    expect(result.error).toBe('org_number_invalid')
    const rpcCreate = supabase.rpc.mock.calls.find(([name]) => name === 'create_company_for_founder')
    expect(rpcCreate).toBeUndefined()
  })
})

const input = {
  teamId: 'team-1',
  settings: { entity_type: 'aktiebolag', company_name: 'Acme AB', org_number: '5560125790', vat_registered: true },
  fiscalPeriod: { startDate: '2026-01-01', endDate: '2026-12-31', name: 'Räkenskapsår 2026' },
}

describe('createCompanyFromOnboarding — founder verification and atomic creation', () => {
  it('stops before creating anything when BankID is required', async () => {
    mockVerifyFounder.mockResolvedValue({ kind: 'bankid_required' })
    const { supabase } = buildSupabase({ user: { id: 'user-1' } })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockCreateServiceClient.mockReturnValue(supabase as never)

    const result = await createCompanyFromOnboarding(input)

    expect(result.bankIdRequired).toBe(true)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('creates the company with one RPC carrying the verification', async () => {
    mockVerifyFounder.mockResolvedValue({ kind: 'decided', status: 'manual_review', reason: 'ab_no_role_in_company', evidence: { x: 1 } })
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_for_founder: { data: 'new-company-id' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockCreateServiceClient.mockReturnValue(supabase as never)

    const result = await createCompanyFromOnboarding(input)

    expect(result).toMatchObject({ companyId: 'new-company-id', verificationPending: true })
    const rpcNames = supabase.rpc.mock.calls.map(([name]) => name)
    expect(rpcNames).toEqual(['create_company_for_founder'])
    expect(supabase.rpc).toHaveBeenCalledWith('create_company_for_founder', expect.objectContaining({
      p_user_id: 'user-1',
      p_org_number: '5560125790',
      p_entity_type: 'aktiebolag',
      p_verification_status: 'manual_review',
      p_verification_reason: 'ab_no_role_in_company',
      p_period_start: '2026-01-01',
      p_period_end: '2026-12-31',
    }))
    // No client-side multi-step writes or rollback deletes any more.
    expect(supabase.from.mock.calls.map(([t]) => t)).not.toContain('company_settings')
  })

  it('never persists browser-supplied TIC data', async () => {
    const { supabase, calls } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_for_founder: { data: 'new-company-id' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockCreateServiceClient.mockReturnValue(supabase as never)

    await createCompanyFromOnboarding({ ...input, ticLookup: { name: 'Injected' } })

    expect(calls.some((c) => c.table === 'companies' && c.method === 'update')).toBe(false)
  })

  it('maps a duplicate org.nr from the RPC to a clear message', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_for_founder: { error: { code: '23505', message: 'dup' } } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockCreateServiceClient.mockReturnValue(supabase as never)

    const result = await createCompanyFromOnboarding(input)
    expect(result.error).toMatch(/finns redan/)
  })

  it('does NOT call the heavy /profile endpoint at signup (regression: was 13 calls/signup)', async () => {
    // The signup path used to call ensureTicSnapshot which fetches /profile.
    // We removed it because it timed out 100% of the time, costing 13 Lens
    // calls each. This test prevents anyone from re-adding it by checking
    // that fetch is never invoked during the action.
    vi.stubGlobal('fetch', vi.fn())

    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: {
        create_company_for_founder: { data: 'new-company-id' },
      },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockCreateServiceClient.mockReturnValue(supabase as never)

    await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Acme AB',
        org_number: '5560125790',
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
    })

    expect(fetch).not.toHaveBeenCalled()
  })
})

