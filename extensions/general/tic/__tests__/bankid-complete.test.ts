import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

vi.mock('../lib/bankid-client', () => ({
  startBankIdAuth: vi.fn(),
  pollBankIdSession: vi.fn(),
  collectBankIdResult: vi.fn(),
  cancelBankIdSession: vi.fn(),
  requestEnrichment: vi.fn().mockResolvedValue({ status: 'failed', completedTypes: [] }),
  fetchEnrichmentData: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
  createClient: vi.fn(),
}))

import { collectBankIdResult, requestEnrichment, fetchEnrichmentData } from '../lib/bankid-client'
import { createServiceClient } from '@/lib/supabase/server'
import { ticExtension } from '../index'

const TEST_KEY = 'a'.repeat(64)

function findCompleteHandler() {
  const route = ticExtension.apiRoutes!.find(
    (r) => r.method === 'POST' && r.path === '/bankid/complete'
  )
  if (!route) throw new Error('POST /bankid/complete route not found in ticExtension.apiRoutes')
  return route.handler
}

function makeSession(overrides: Partial<{ status: string; user: unknown }> = {}) {
  return {
    sessionId: 'test-session',
    status: 'complete',
    user: {
      personalNumber: '199001011234',
      givenName: 'Anna',
      surname: 'Andersson',
      name: 'Anna Andersson',
    },
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof collectBankIdResult>>
}

type QueuedResult = { data?: unknown; error?: unknown }

function mockServiceClient(fromResults: QueuedResult[]) {
  const queue = [...fromResults]

  const chain = (): unknown => {
    const result = queue.shift() ?? { data: null, error: null }
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
        return () => chain2(result)
      },
    }
    return new Proxy({}, handler)
  }
  const chain2 = (result: QueuedResult): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
        return () => chain2(result)
      },
    }
    return new Proxy({}, handler)
  }

  const admin = {
    createUser: vi.fn().mockResolvedValue({ data: { user: { id: 'new-user-uuid' } }, error: null }),
    updateUserById: vi.fn().mockResolvedValue({ data: {}, error: null }),
    generateLink: vi.fn().mockResolvedValue({
      data: { properties: { hashed_token: 'magic-token-hash' } },
      error: null,
    }),
    getUserById: vi.fn().mockResolvedValue({
      data: { user: { id: 'existing-user', email: 'existing@example.com' } },
    }),
  }

  const client = {
    from: vi.fn().mockImplementation(() => chain()),
    auth: { admin },
  }

  vi.mocked(createServiceClient).mockReturnValue(client as unknown as ReturnType<typeof createServiceClient>)

  return { admin, client }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BANKID_ENCRYPTION_KEY', TEST_KEY)
  // Login now resolves its provider through getBankIdProvider() like every
  // other BankID flow, so the kill switch has to be on for the TIC provider
  // (and therefore the mocked TIC client) to be the one that answers.
  vi.stubEnv('NEXT_PUBLIC_BANKID_ENABLED', 'true')
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /bankid/complete', () => {
  describe('provider convergence', () => {
    it('refuses when BankID is switched off, instead of authenticating anyway', async () => {
      // Login used to call the TIC client directly, so NEXT_PUBLIC_BANKID_ENABLED
      // stopped consent signing while leaving the route that hands out a session
      // wide open. It now resolves the provider like everything else, and with
      // the switch off there is no TIC provider to answer.
      vi.stubEnv('NEXT_PUBLIC_BANKID_ENABLED', 'false')
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'login' },
      })
      const { status } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(400)
      expect(vi.mocked(collectBankIdResult)).not.toHaveBeenCalled()
      expect(admin.generateLink).not.toHaveBeenCalled()
    })

    it('verifies the outcome with the provider rather than trusting the browser', async () => {
      // The browser posts sessionId and claims the order finished. The route
      // must re-read the outcome; a session the provider does not report as
      // complete gets no Supabase session.
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession({ status: 'pending', user: undefined }))
      const { admin } = mockServiceClient([])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'login' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(400)
      expect(body.error).toBe('session_invalid')
      expect(admin.generateLink).not.toHaveBeenCalled()
    })
  })

  describe('signup mode — removed', () => {
    it('refuses to create an account, whatever the payload says', async () => {
      // This route used to accept mode: 'signup' and create a Supabase user
      // outright. Nothing in the product ever asked for it, and the account it
      // produced had no legal acceptance, no plan and no company — so it could
      // not finish onboarding either. The CWE-287 guard that used to sit in
      // that branch (refuse when the email is already registered) is now
      // structural: there is no branch that can create an account here at all.
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin, client } = mockServiceClient([
        { data: null },
        { data: { id: 'victim-user-uuid' } },
      ])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'signup', email: 'victim@example.com' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string; data?: unknown }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(400)
      expect(body.error).toBe('unsupported_mode')
      expect(body.data).toBeUndefined()

      // No account mutation, no session issuance, and no database traffic at
      // all — the mode is rejected before the BankID session is even read.
      expect(admin.createUser).not.toHaveBeenCalled()
      expect(admin.updateUserById).not.toHaveBeenCalled()
      expect(admin.generateLink).not.toHaveBeenCalled()
      expect(vi.mocked(client.from)).not.toHaveBeenCalled()
      expect(vi.mocked(collectBankIdResult)).not.toHaveBeenCalled()
    })

    it('refuses any mode that is not login', async () => {
      const { client } = mockServiceClient([])
      for (const mode of ['link', 'verify', '']) {
        const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
          method: 'POST',
          body: { sessionId: 'test-session', mode },
        })
        const { status } = await parseJsonResponse(await findCompleteHandler()(req))
        expect(status).toBe(400)
      }
      expect(vi.mocked(client.from)).not.toHaveBeenCalled()
    })
  })

  describe('login mode', () => {
    it('returns 404 no_account when the BankID pnr is not linked to any user', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      const { admin } = mockServiceClient([
        { data: null }, // pnr lookup → not linked
      ])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'login' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(404)
      expect(body.error).toBe('no_account')
      expect(admin.generateLink).not.toHaveBeenCalled()
    })
  })

  describe('enrichment — SPAR + CompanyRoles', () => {
    it('requests both SPAR and CompanyRoles, fetches data, and persists only companyRoles (no PII) to bankid_enrichment', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(makeSession())
      vi.mocked(requestEnrichment).mockResolvedValueOnce({
        enrichmentId: 'enr-1',
        sessionId: 'test-session',
        status: 'Completed',
        requestedTypes: ['SPAR', 'CompanyRoles'],
        completedTypes: ['SPAR', 'CompanyRoles'],
        secureUrl: '/api/v1/enrichment/data/abc',
        secureUrlExpiresAtUtc: '2026-05-06T12:00:00Z',
      })
      vi.mocked(fetchEnrichmentData).mockResolvedValueOnce({
        personalNumber: '199001011234',
        name: 'Anna Andersson',
        enrichedAtUtc: '2026-05-06T11:30:00Z',
        spar: {
          Person_IdNummer: '199001011234',
          Person_PersonIdTyp: 'PERSONNR',
          Skydd_Sekretessmarkering: false,
          Skydd_SkyddadFolkbokforing: false,
          Namn_Fornamn: 'Anna',
          Namn_Efternamn: 'Andersson',
          PersonDetaljer_Kon: 'K',
          PersonDetaljer_Fodelsedatum: '1990-01-01',
          Folkbokforingsadress_SvenskAdress_Utdelningsadress1: 'Storgatan 1',
          Folkbokforingsadress_SvenskAdress_PostNr: '11122',
          Folkbokforingsadress_SvenskAdress_Postort: 'Stockholm',
        },
        companyRoles: [
          {
            companyId: 12345,
            companyRegistrationNumber: '5566778899',
            legalName: 'Exempel AB',
            legalEntityType: 'AB',
            positionTypes: ['LED'],
            positionDescriptions: ['Styrelseledamot'],
            positionStart: '2020-01-15',
            positionEnd: null,
            companyStatus: 'Aktivt',
          },
        ],
      })
      const { client } = mockServiceClient([
        // pnr lookup → already linked, so this is an ordinary login. No
        // personal_number_hash on the row means no legacy-hash upgrade write.
        { data: { id: 'ident-1', user_id: 'existing-user' } },
      ])

      // Intercept the bankid_enrichment upsert so we can assert the persisted shape
      // contains no SPAR / personnummer / name. Other tables fall through to the
      // queued chain.
      const upsertSpy = vi.fn().mockResolvedValue({ error: null })
      const origFrom = client.from as unknown as ReturnType<typeof vi.fn>
      const queuedFrom = origFrom.getMockImplementation() as (table: string) => unknown
      origFrom.mockImplementation((table: string) => {
        if (table === 'bankid_enrichment') {
          return { upsert: upsertSpy }
        }
        return queuedFrom(table)
      })

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'login' },
      })
      const { status, body } = await parseJsonResponse<{
        data?: { tokenHash?: string; isNewUser?: boolean }
      }>(await findCompleteHandler()(req))

      expect(status).toBe(200)
      expect(body.data?.isNewUser).toBe(false)
      expect(vi.mocked(requestEnrichment)).toHaveBeenCalledWith(
        'test-session',
        ['SPAR', 'CompanyRoles']
      )
      expect(vi.mocked(fetchEnrichmentData)).toHaveBeenCalledWith('/api/v1/enrichment/data/abc')

      // Persisted row must contain company_roles + enriched_at_utc only.
      // SPAR (personnummer / name / address / birth date) must NOT be stored,
      // even when TIC returns it — those fields live in bankid_identities (encrypted).
      expect(upsertSpy).toHaveBeenCalledTimes(1)
      const [persistedRow] = upsertSpy.mock.calls[0] as [Record<string, unknown>]
      expect(persistedRow).toEqual({
        user_id: expect.any(String),
        company_roles: expect.any(Array),
        enriched_at_utc: '2026-05-06T11:30:00Z',
      })
      expect(persistedRow).not.toHaveProperty('spar')
      expect(persistedRow).not.toHaveProperty('personalNumber')
      expect(persistedRow).not.toHaveProperty('name')
    })
  })

  describe('input validation', () => {
    it('returns 400 session_invalid when BankID session is not complete', async () => {
      vi.mocked(collectBankIdResult).mockResolvedValue(
        makeSession({ status: 'pending', user: undefined })
      )
      mockServiceClient([])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session', mode: 'login' },
      })
      const { status, body } = await parseJsonResponse<{ error?: string }>(
        await findCompleteHandler()(req)
      )

      expect(status).toBe(400)
      expect(body.error).toBe('session_invalid')
    })

    it('returns 400 when mode is missing entirely', async () => {
      mockServiceClient([])

      const req = createMockRequest('/api/extensions/ext/tic/bankid/complete', {
        method: 'POST',
        body: { sessionId: 'test-session' },
      })
      const { status } = await parseJsonResponse(await findCompleteHandler()(req))

      expect(status).toBe(400)
      // collectBankIdResult should never be called — validation happens first.
      expect(collectBankIdResult).not.toHaveBeenCalled()
    })
  })
})
