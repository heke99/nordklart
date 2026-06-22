import 'server-only'

import { randomUUID } from 'crypto'
import {
  getBolagsverketConfig,
  getBolagsverketConfigSummary,
  type BolagsverketAuthMethod,
  type BolagsverketConfig,
  type BolagsverketConfigSummary,
} from './bolagsverket-config'

export type BolagsverketApiError = {
  type?: string
  instance?: string
  status?: number
  timestamp?: string | null
  requestId?: string | null
  title?: string
  detail?: string
  error?: string
  error_description?: string
  cause?: string
  causeCode?: string
  causeName?: string
  url?: string
  host?: string
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

type TokenAuthAttemptMethod = Exclude<BolagsverketAuthMethod, 'auto'>

type CachedToken = {
  accessToken: string
  expiresAt: number
  method: TokenAuthAttemptMethod
}

export type BolagsverketTokenDiagnostic = {
  ok: boolean
  method: TokenAuthAttemptMethod
  status: number | null
  requestId: string
  error: string | null
  details: BolagsverketApiError | string | null
  expiresIn: number | null
  scope: string | null
}

export type BolagsverketResourceDiagnostic = {
  ok: boolean
  status: number | null
  requestId: string | null
  error: string | null
  details: BolagsverketApiError | string | null
}

export type BolagsverketConnectionDiagnostics = BolagsverketConfigSummary & {
  token: BolagsverketTokenDiagnostic | null
  isAlive: BolagsverketResourceDiagnostic | null
}

const tokenCache = new Map<string, CachedToken>()

export class BolagsverketClientError extends Error {
  readonly status: number
  readonly requestId: string
  readonly details: BolagsverketApiError | string | null
  readonly code: string

  constructor(
    message: string,
    status: number,
    requestId: string,
    details: BolagsverketApiError | string | null = null,
    code = 'bolagsverket_request_failed',
  ) {
    super(message)
    this.name = 'BolagsverketClientError'
    this.status = status
    this.requestId = requestId
    this.details = details
    this.code = code
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

function safeDetails(details: unknown): BolagsverketApiError | string | null {
  if (details == null) return null
  if (typeof details === 'string') return details.slice(0, 600)
  if (typeof details !== 'object') return String(details).slice(0, 600)

  const value = details as Record<string, unknown>
  return {
    type: typeof value.type === 'string' ? value.type : undefined,
    instance: typeof value.instance === 'string' ? value.instance : undefined,
    status: typeof value.status === 'number' ? value.status : undefined,
    timestamp: typeof value.timestamp === 'string' ? value.timestamp : null,
    requestId: typeof value.requestId === 'string' ? value.requestId : null,
    title: typeof value.title === 'string' ? value.title : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
    error: typeof value.error === 'string' ? value.error : undefined,
    error_description: typeof value.error_description === 'string' ? value.error_description : undefined,
    cause: typeof value.cause === 'string' ? value.cause : undefined,
    causeCode: typeof value.causeCode === 'string' ? value.causeCode : undefined,
    causeName: typeof value.causeName === 'string' ? value.causeName : undefined,
    url: typeof value.url === 'string' ? value.url : undefined,
    host: typeof value.host === 'string' ? value.host : undefined,
  }
}


function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

function describeFetchFailure(error: unknown, url: string): BolagsverketApiError {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null
  const causeRecord = cause && typeof cause === 'object' ? cause as Record<string, unknown> : null
  let parsedHost: string | undefined

  try {
    parsedHost = new URL(url).host
  } catch {
    parsedHost = undefined
  }

  const causeCode = typeof causeRecord?.code === 'string'
    ? causeRecord.code
    : typeof causeRecord?.errno === 'string'
      ? causeRecord.errno
      : undefined
  const causeMessage = cause instanceof Error
    ? cause.message
    : typeof cause === 'string'
      ? cause
      : undefined
  const causeName = cause instanceof Error
    ? cause.name
    : typeof causeRecord?.name === 'string'
      ? causeRecord.name
      : undefined

  return {
    title: 'Network request failed before an HTTP response was received.',
    detail: safeErrorMessage(error),
    error: 'fetch_failed',
    error_description: causeMessage,
    cause: causeMessage,
    causeCode,
    causeName,
    url,
    host: parsedHost,
  }
}

function networkCodeFrom(error: unknown): string {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null
  const causeRecord = cause && typeof cause === 'object' ? cause as Record<string, unknown> : null
  if (error instanceof DOMException && error.name === 'AbortError') return 'network_timeout'
  if (error instanceof Error && error.name === 'AbortError') return 'network_timeout'
  if (typeof causeRecord?.code === 'string') return causeRecord.code
  if (typeof causeRecord?.errno === 'string') return causeRecord.errno
  return 'network_error'
}

async function fetchWithBolagsverketDiagnostics(url: string, init: RequestInit, requestId: string, message: string): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    throw new BolagsverketClientError(
      message,
      0,
      requestId,
      describeFetchFailure(error, url),
      networkCodeFrom(error),
    )
  }
}

function cacheKey(config: BolagsverketConfig): string {
  return [config.environment, config.tokenUrl, config.clientId, config.scopes, config.authMethod].join('|')
}

function tokenHeaders(config: BolagsverketConfig, method: TokenAuthAttemptMethod): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  if (method === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`
  }

  return headers
}

function tokenBody(config: BolagsverketConfig, method: TokenAuthAttemptMethod): URLSearchParams {
  const body = new URLSearchParams({ grant_type: 'client_credentials', scope: config.scopes })

  // Bolagsverkets connection guide documents client_id/client_secret in the
  // form body. Basic auth remains opt-in/diagnostic fallback only.
  if (method === 'post') {
    body.set('client_id', config.clientId)
    body.set('client_secret', config.clientSecret)
  }

  return body
}

function methodsFor(config: BolagsverketConfig): TokenAuthAttemptMethod[] {
  if (config.authMethod === 'auto') return ['post', 'basic']
  return [config.authMethod]
}

async function fetchAccessTokenWithMethod(
  config: BolagsverketConfig,
  method: TokenAuthAttemptMethod,
): Promise<{ token: TokenResponse; diagnostic: BolagsverketTokenDiagnostic }> {
  const requestId = randomUUID()
  const response = await fetchWithBolagsverketDiagnostics(config.tokenUrl, {
    method: 'POST',
    headers: tokenHeaders(config, method),
    body: tokenBody(config, method),
    signal: withTimeout(config.timeoutMs),
  }, requestId, 'Nätverksfel vid tokenanrop till Bolagsverket.')

  const payload = await readResponse(response)
  if (!response.ok) {
    const details = safeDetails(payload)
    throw new BolagsverketClientError(
      'Kunde inte hämta access token från Bolagsverket.',
      response.status,
      requestId,
      details,
      response.status === 401 || response.status === 403 ? 'token_rejected' : 'token_failed',
    )
  }

  const token = payload as TokenResponse | null
  if (!token?.access_token) {
    throw new BolagsverketClientError(
      'Bolagsverket returnerade inget access token.',
      response.status,
      requestId,
      safeDetails(payload),
      'token_missing',
    )
  }

  return {
    token,
    diagnostic: {
      ok: true,
      method,
      status: response.status,
      requestId,
      error: null,
      details: null,
      expiresIn: Number.isFinite(token.expires_in) ? Number(token.expires_in) : null,
      scope: token.scope ?? null,
    },
  }
}

async function getAccessTokenRecord(config: BolagsverketConfig): Promise<CachedToken> {
  const key = cacheKey(config)
  const cachedToken = tokenCache.get(key)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken

  let lastError: BolagsverketClientError | null = null
  for (const method of methodsFor(config)) {
    try {
      const { token } = await fetchAccessTokenWithMethod(config, method)
      const expiresIn = Number.isFinite(token.expires_in) ? Number(token.expires_in) : 300
      const nextToken = {
        accessToken: token.access_token!,
        expiresAt: Date.now() + Math.max(60, expiresIn - 30) * 1000,
        method,
      }
      tokenCache.set(key, nextToken)
      return nextToken
    } catch (error) {
      if (error instanceof BolagsverketClientError) {
        lastError = error
        if (config.authMethod === 'auto' && (error.status === 401 || error.status === 403)) continue
      }
      throw error
    }
  }

  throw lastError ?? new BolagsverketClientError('Bolagsverket-token kunde inte hämtas.', 0, randomUUID(), null, 'token_failed')
}

async function getAccessToken(config: BolagsverketConfig): Promise<string> {
  return (await getAccessTokenRecord(config)).accessToken
}

async function diagnoseToken(config: BolagsverketConfig): Promise<BolagsverketTokenDiagnostic> {
  let lastDiagnostic: BolagsverketTokenDiagnostic | null = null

  for (const method of methodsFor(config)) {
    try {
      const { diagnostic } = await fetchAccessTokenWithMethod(config, method)
      return diagnostic
    } catch (error) {
      if (error instanceof BolagsverketClientError) {
        lastDiagnostic = {
          ok: false,
          method,
          status: error.status || null,
          requestId: error.requestId,
          error: error.code,
          details: error.details,
          expiresIn: null,
          scope: null,
        }
        if (config.authMethod === 'auto' && (error.status === 401 || error.status === 403)) continue
      }
      if (error instanceof Error) {
        return {
          ok: false,
          method,
          status: null,
          requestId: randomUUID(),
          error: error.message,
          details: describeFetchFailure(error, config.tokenUrl),
          expiresIn: null,
          scope: null,
        }
      }
      throw error
    }
  }

  return lastDiagnostic ?? {
    ok: false,
    method: 'post',
    status: null,
    requestId: randomUUID(),
    error: 'token_failed',
    details: null,
    expiresIn: null,
    scope: null,
  }
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

  async diagnoseConnection(): Promise<BolagsverketConnectionDiagnostics> {
    const summary = getBolagsverketConfigSummary()
    const token = await diagnoseToken(this.config)
    if (!token.ok) return { ...summary, token, isAlive: null }

    const requestId = randomUUID()
    try {
      const accessToken = (await getAccessTokenRecord(this.config)).accessToken
      const isAliveUrl = `${this.config.apiBaseUrl}/isalive`
      const response = await fetchWithBolagsverketDiagnostics(isAliveUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: '*/*',
          'X-Request-Id': requestId,
        },
        signal: withTimeout(this.config.timeoutMs),
      }, requestId, 'Nätverksfel vid Bolagsverket /isalive.')
      const payload = await readResponse(response)
      return {
        ...summary,
        token,
        isAlive: {
          ok: response.ok,
          status: response.status,
          requestId,
          error: response.ok ? null : 'isalive_failed',
          details: response.ok ? null : safeDetails(payload),
        },
      }
    } catch (error) {
      return {
        ...summary,
        token,
        isAlive: {
          ok: false,
          status: error instanceof BolagsverketClientError ? error.status || null : null,
          requestId: error instanceof BolagsverketClientError ? error.requestId : requestId,
          error: error instanceof BolagsverketClientError ? error.code : error instanceof Error ? error.message : 'isalive_failed',
          details: error instanceof BolagsverketClientError ? error.details : describeFetchFailure(error, `${this.config.apiBaseUrl}/isalive`),
        },
      }
    }
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
    const documentUrl = `${this.config.apiBaseUrl}/dokument/${encodeURIComponent(dokumentId)}`
    const response = await fetchWithBolagsverketDiagnostics(documentUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/zip, application/octet-stream, */*',
        'X-Request-Id': requestId,
      },
      signal: withTimeout(this.config.timeoutMs),
    }, requestId, 'Nätverksfel vid dokumenthämtning från Bolagsverket.')
    if (!response.ok) {
      const payload = await readResponse(response)
      throw new BolagsverketClientError(
        'Kunde inte hämta dokument från Bolagsverket.',
        response.status,
        requestId,
        safeDetails(payload),
        response.status === 401 || response.status === 403 ? 'api_forbidden' : 'api_failed',
      )
    }
    return response.arrayBuffer()
  }

  private async request(path: string, options: { method: 'GET' | 'POST'; scope: 'read' | 'ping'; body?: unknown }): Promise<unknown> {
    const token = await getAccessToken(this.config)
    const requestId = randomUUID()
    const requestUrl = `${this.config.apiBaseUrl}${path}`
    const response = await fetchWithBolagsverketDiagnostics(requestUrl, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: options.body ? 'application/json' : '*/*',
        'X-Request-Id': requestId,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: withTimeout(this.config.timeoutMs),
    }, requestId, `Nätverksfel vid Bolagsverket ${path}.`)
    const payload = await readResponse(response)
    if (!response.ok) {
      throw new BolagsverketClientError(
        'Bolagsverket-anropet misslyckades.',
        response.status,
        requestId,
        safeDetails(payload),
        response.status === 401 || response.status === 403 ? 'api_forbidden' : 'api_failed',
      )
    }
    return payload
  }
}

export function resetBolagsverketTokenCacheForTests() {
  tokenCache.clear()
}
