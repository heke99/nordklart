import 'server-only'

import { randomUUID } from 'crypto'
import { getBolagsverketConfig, type BolagsverketConfig } from './bolagsverket-config'

export type BolagsverketApiError = {
  type?: string
  instance?: string
  status?: number
  timestamp?: string | null
  requestId?: string | null
  title?: string
  detail?: string
}

export type BolagsverketOrganizationRequest = {
  identitetsbeteckning: string
}

export type BolagsverketOrganizationsResponse = {
  organisationer?: BolagsverketOrganization[] | null
}

export type BolagsverketCodeText = {
  kod?: string | null
  klartext?: string | null
}

export type BolagsverketSourceError = {
  typ?: string | null
  felBeskrivning?: string | null
}

export type BolagsverketDataProducer = 'Bolagsverket' | 'SCB' | string

export type BolagsverketValue<T> = T & {
  dataproducent?: BolagsverketDataProducer | null
  fel?: BolagsverketSourceError | null
}

export type BolagsverketOrganizationName = {
  namn?: string | null
  organisationsnamntyp?: BolagsverketCodeText | null
  registreringsdatum?: string | null
  verksamhetsbeskrivningSarskiltForetagsnamn?: string | null
}

export type BolagsverketOrganization = {
  organisationsidentitet?: {
    identitetsbeteckning?: string | null
    typ?: BolagsverketCodeText | null
  } | null
  namnskyddslopnummer?: number | null
  organisationsnamn?: BolagsverketValue<{
    organisationsnamnLista?: BolagsverketOrganizationName[] | null
  }> | null
  registreringsland?: BolagsverketCodeText | null
  reklamsparr?: BolagsverketValue<{ kod?: 'JA' | 'NEJ' | string | null }> | null
  organisationsform?: BolagsverketValue<BolagsverketCodeText> | null
  avregistreradOrganisation?: BolagsverketValue<{ avregistreringsdatum?: string | null }> | null
  avregistreringsorsak?: BolagsverketValue<BolagsverketCodeText> | null
  pagaendeAvvecklingsEllerOmstruktureringsforfarande?: BolagsverketValue<{
    pagaendeAvvecklingsEllerOmstruktureringsforfarandeLista?: Array<{
      kod?: string | null
      klartext?: string | null
      fromDatum?: string | null
    }> | null
  }> | null
  juridiskForm?: BolagsverketValue<BolagsverketCodeText> | null
  verksamOrganisation?: BolagsverketValue<{ kod?: 'JA' | 'NEJ' | string | null }> | null
  organisationsdatum?: BolagsverketValue<{
    registreringsdatum?: string | null
    infortHosScb?: string | null
  }> | null
  verksamhetsbeskrivning?: BolagsverketValue<{ beskrivning?: string | null }> | null
  naringsgrenOrganisation?: BolagsverketValue<{
    sni?: BolagsverketCodeText[] | null
  }> | null
  postadressOrganisation?: BolagsverketValue<{
    postadress?: {
      postnummer?: string | null
      utdelningsadress?: string | null
      land?: string | null
      coAdress?: string | null
      postort?: string | null
    } | null
  }> | null
}

export type BolagsverketDocumentListResponse = {
  dokument?: Array<{
    dokumentId?: string | null
    filformat?: string | null
    rapporteringsperiodTom?: string | null
    registreringstidpunkt?: string | null
  }> | null
}

type TokenResponse = {
  access_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

type CachedToken = {
  accessToken: string
  expiresAt: number
}

let cachedToken: CachedToken | null = null

export class BolagsverketClientError extends Error {
  readonly status: number
  readonly requestId: string
  readonly details: BolagsverketApiError | string | null

  constructor(message: string, status: number, requestId: string, details: BolagsverketApiError | string | null = null) {
    super(message)
    this.name = 'BolagsverketClientError'
    this.status = status
    this.requestId = requestId
    this.details = details
  }
}

function withTimeout(timeoutMs: number): AbortSignal {
  const AbortSignalWithTimeout = AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal }
  if (AbortSignalWithTimeout.timeout) return AbortSignalWithTimeout.timeout(timeoutMs)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const maybeNodeTimeout = timeout as unknown as { unref?: () => void }
  maybeNodeTimeout.unref?.()
  return controller.signal
}

async function readResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return response.json().catch(() => null)
  return response.text().catch(() => null)
}

function tokenHeaders(config: BolagsverketConfig): HeadersInit {
  if (config.authMethod === 'post') return { 'Content-Type': 'application/x-www-form-urlencoded' }
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
  }
}

function tokenBody(config: BolagsverketConfig): URLSearchParams {
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: config.scopes })
  if (config.authMethod === 'post') {
    body.set('client_id', config.clientId)
    body.set('client_secret', config.clientSecret)
  }
  return body
}

async function getAccessToken(config: BolagsverketConfig): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.accessToken

  const requestId = randomUUID()
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: tokenHeaders(config),
    body: tokenBody(config),
    signal: withTimeout(config.timeoutMs),
  })

  const payload = await readResponse(response)
  if (!response.ok) {
    throw new BolagsverketClientError('Kunde inte hämta access token från Bolagsverket.', response.status, requestId, payload as BolagsverketApiError | string | null)
  }

  const token = payload as TokenResponse | null
  if (!token?.access_token) {
    throw new BolagsverketClientError('Bolagsverket returnerade inget access token.', response.status, requestId, payload as BolagsverketApiError | string | null)
  }

  const expiresIn = Number.isFinite(token.expires_in) ? Number(token.expires_in) : 300
  cachedToken = {
    accessToken: token.access_token,
    expiresAt: Date.now() + Math.max(60, expiresIn - 30) * 1000,
  }
  return cachedToken.accessToken
}

export class BolagsverketVardefullaDatamangderClient {
  constructor(private readonly config: BolagsverketConfig) {}

  static fromEnv(): BolagsverketVardefullaDatamangderClient | null {
    const config = getBolagsverketConfig()
    return config ? new BolagsverketVardefullaDatamangderClient(config) : null
  }

  get environment() {
    return this.config.environment
  }

  async isAlive(): Promise<boolean> {
    const response = await this.request('/isalive', { method: 'GET', scope: 'ping' })
    return typeof response === 'string' ? response.trim().toUpperCase() === 'OK' : true
  }

  async lookupOrganization(identitetsbeteckning: string): Promise<BolagsverketOrganizationsResponse> {
    return this.request('/organisationer', {
      method: 'POST',
      scope: 'read',
      body: { identitetsbeteckning },
    }) as Promise<BolagsverketOrganizationsResponse>
  }

  async listDocuments(identitetsbeteckning: string): Promise<BolagsverketDocumentListResponse> {
    return this.request('/dokumentlista', {
      method: 'POST',
      scope: 'read',
      body: { identitetsbeteckning },
    }) as Promise<BolagsverketDocumentListResponse>
  }

  async getDocumentZip(dokumentId: string): Promise<ArrayBuffer> {
    const token = await getAccessToken(this.config)
    const requestId = randomUUID()
    const response = await fetch(`${this.config.apiBaseUrl}/dokument/${encodeURIComponent(dokumentId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Request-Id': requestId,
      },
      signal: withTimeout(this.config.timeoutMs),
    })
    if (!response.ok) {
      const payload = await readResponse(response)
      throw new BolagsverketClientError('Kunde inte hämta dokument från Bolagsverket.', response.status, requestId, payload as BolagsverketApiError | string | null)
    }
    return response.arrayBuffer()
  }

  private async request(path: string, options: { method: 'GET' | 'POST'; scope: 'read' | 'ping'; body?: unknown }): Promise<unknown> {
    const token = await getAccessToken(this.config)
    const requestId = randomUUID()
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Request-Id': requestId,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: withTimeout(this.config.timeoutMs),
    })
    const payload = await readResponse(response)
    if (!response.ok) {
      throw new BolagsverketClientError('Bolagsverket-anropet misslyckades.', response.status, requestId, payload as BolagsverketApiError | string | null)
    }
    return payload
  }
}

export function resetBolagsverketTokenCacheForTests() {
  cachedToken = null
}
