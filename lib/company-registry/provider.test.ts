import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { lookupCompanyAtBolagsverket, listAnnualReportsAtBolagsverket } from './provider'
import { resetBolagsverketTokenCacheForTests } from './bolagsverket-client'

const ORIGINAL_ENV = process.env

function configureEnv() {
  process.env.BOLAGSVERKET_ENVIRONMENT = 'production'
  process.env.BOLAGSVERKET_CLIENT_ID = 'client-id'
  process.env.BOLAGSVERKET_CLIENT_SECRET = 'client-secret'
  process.env.BOLAGSVERKET_TOKEN_URL = 'https://portal.api.bolagsverket.se/oauth2/token.'
  process.env.BOLAGSVERKET_API_BASE_URL = 'https://gw.api.bolagsverket.se/vardefulla-datamangder/v1'
}

function tokenResponse() {
  return new Response(JSON.stringify({ access_token: 'access-token', token_type: 'Bearer', expires_in: 300 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Bolagsverket company registry boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetBolagsverketTokenCacheForTests()
    process.env = { ...ORIGINAL_ENV }
    delete process.env.BOLAGSVERKET_CLIENT_ID
    delete process.env.BOLAGSVERKET_CLIENT_SECRET
    delete process.env.BOLAGSVERKET_TOKEN_URL
    delete process.env.BOLAGSVERKET_API_BASE_URL
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetBolagsverketTokenCacheForTests()
    process.env = ORIGINAL_ENV
  })

  it('does not make third-party calls before approved configuration exists', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(lookupCompanyAtBolagsverket('5560125790')).resolves.toEqual({ available: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses OAuth2 client credentials and normalizes Värdefulla datamängder company data', async () => {
    configureEnv()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://portal.api.bolagsverket.se/oauth2/token') return tokenResponse()
      if (url === 'https://gw.api.bolagsverket.se/vardefulla-datamangder/v1/organisationer') {
        expect(init?.method).toBe('POST')
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer access-token')
        expect(JSON.parse(String(init?.body))).toEqual({ identitetsbeteckning: '5560125790' })
        return new Response(JSON.stringify({
          organisationer: [{
            organisationsidentitet: { identitetsbeteckning: '5560125790' },
            organisationsform: { kod: 'AB', klartext: 'Aktiebolag', fel: null, dataproducent: 'Bolagsverket' },
            verksamOrganisation: { kod: 'JA', fel: null, dataproducent: 'SCB' },
            organisationsnamn: {
              organisationsnamnLista: [{
                namn: 'Nordklart Test AB',
                organisationsnamntyp: { kod: 'FORETAGSNAMN', klartext: 'Företagsnamn' },
                registreringsdatum: '2024-03-15',
              }],
              fel: null,
              dataproducent: 'Bolagsverket',
            },
            postadressOrganisation: {
              postadress: { utdelningsadress: 'Storgatan 1', postnummer: '12345', postort: 'Stockholm', land: 'Sverige' },
              fel: null,
              dataproducent: 'SCB',
            },
            naringsgrenOrganisation: {
              sni: [{ kod: '62010', klartext: 'Dataprogrammering' }],
              fel: null,
              dataproducent: 'SCB',
            },
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await lookupCompanyAtBolagsverket('5560125790')

    expect(result.available).toBe(true)
    expect(result).toMatchObject({
      found: true,
      company: {
        organizationNumber: '5560125790',
        companyName: 'Nordklart Test AB',
        legalForm: 'aktiebolag',
        registryStatus: 'active',
        address: { street: 'Storgatan 1', postalCode: '12345', city: 'Stockholm' },
        sniCodes: [{ code: '62010', name: 'Dataprogrammering' }],
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('normalizes annual report document list', async () => {
    configureEnv()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://portal.api.bolagsverket.se/oauth2/token') return tokenResponse()
      if (url === 'https://gw.api.bolagsverket.se/vardefulla-datamangder/v1/dokumentlista') {
        return new Response(JSON.stringify({ dokument: [{ dokumentId: 'doc-1', filformat: 'zip', rapporteringsperiodTom: '2025-12-31' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`Unexpected URL ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(listAnnualReportsAtBolagsverket('5560125790')).resolves.toEqual({
      available: true,
      documents: [{ dokumentId: 'doc-1', filformat: 'zip', rapporteringsperiodTom: '2025-12-31' }],
    })
  })
})
