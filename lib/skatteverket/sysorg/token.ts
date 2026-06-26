import 'server-only'
import https from 'node:https'
import type { IncomingHttpHeaders } from 'node:http'
import { URL } from 'node:url'
import { createLogger } from '@/lib/logger'
import {
  getSkvOAuthClientId,
  getSkvOAuthClientSecret,
  getSkvOrgCertBase64,
  getSkvOrgCertPin,
  getSkvRequestTimeoutMs,
  getSkvScopeString,
  getSkvSysorgEnabled,
  getSkvSysorgTokenUrl,
  requireSkvConfigValue,
  SkvConfigurationError,
} from './config'

const log = createLogger('skv-sysorg-token')
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

type CachedToken = {
  accessToken: string
  tokenType: string
  scope: string
  expiresAt: number
}

type TokenResponse = {
  access_token?: string
  expires_in?: number | string
  token_type?: string
  scope?: string
  [key: string]: unknown
}

let tokenCache: CachedToken | null = null
let tokenInFlight: Promise<CachedToken> | null = null

export function clearSkvSysorgTokenCache() {
  tokenCache = null
  tokenInFlight = null
}

export function getCachedSkvSysorgTokenMeta() {
  if (!tokenCache) return null
  return {
    tokenType: tokenCache.tokenType,
    scope: tokenCache.scope,
    expiresAt: new Date(tokenCache.expiresAt).toISOString(),
    expiresInSeconds: Math.max(0, Math.floor((tokenCache.expiresAt - Date.now()) / 1000)),
  }
}

export async function getSkvSysorgAccessToken(options: { forceRefresh?: boolean } = {}): Promise<CachedToken> {
  if (!getSkvSysorgEnabled()) {
    throw new SkvConfigurationError('Skatteverket sysorg är avstängt. Sätt SKV_SYSORG_ENABLED=true först.')
  }

  if (!options.forceRefresh && tokenCache && tokenCache.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    return tokenCache
  }

  if (!options.forceRefresh && tokenInFlight) return tokenInFlight

  tokenInFlight = requestAccessToken()
    .then((token) => {
      tokenCache = token
      return token
    })
    .finally(() => {
      tokenInFlight = null
    })

  return tokenInFlight
}

async function requestAccessToken(): Promise<CachedToken> {
  const tokenUrl = getSkvSysorgTokenUrl()
  const clientId = requireSkvConfigValue(getSkvOAuthClientId(), 'SKV_OAUTH_CLIENT_ID')
  const clientSecret = requireSkvConfigValue(getSkvOAuthClientSecret(), 'SKV_OAUTH_CLIENT_SECRET')
  const certBase64 = requireSkvConfigValue(getSkvOrgCertBase64(), 'SKV_ORG_CERT_P12_BASE64')
  const certPin = requireSkvConfigValue(getSkvOrgCertPin(), 'SKV_ORG_CERT_PIN')
  const scope = getSkvScopeString()

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  }).toString()

  const pfx = Buffer.from(certBase64, 'base64')
  const url = new URL(tokenUrl)

  log.info('requesting Skatteverket sysorg token', {
    host: url.host,
    pathname: url.pathname,
    scope,
  })

  const response = await postFormWithP12(url, body, pfx, certPin)
  if (response.status < 200 || response.status >= 300) {
    const safeBody = response.body.slice(0, 400)
    throw new SkvTokenError(
      `Skatteverket token-anrop misslyckades (${response.status}). Kontrollera OAuth-nycklar, Expisoft-certifikat och scope.`,
      response.status,
      safeBody,
    )
  }

  let data: TokenResponse
  try {
    data = JSON.parse(response.body) as TokenResponse
  } catch (err) {
    throw new SkvTokenError('Skatteverket token-svar var inte giltig JSON.', response.status, response.body.slice(0, 200), err)
  }

  if (!data.access_token) {
    throw new SkvTokenError('Skatteverket token-svar saknade access_token.', response.status, response.body.slice(0, 200))
  }

  const expiresIn = Number(data.expires_in ?? 3600)
  const safeExpiresIn = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600

  return {
    accessToken: data.access_token,
    tokenType: data.token_type ?? 'Bearer',
    scope: data.scope ?? scope,
    expiresAt: Date.now() + safeExpiresIn * 1000,
  }
}

function postFormWithP12(
  url: URL,
  body: string,
  pfx: Buffer,
  passphrase: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  const timeoutMs = getSkvRequestTimeoutMs()

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        pfx,
        passphrase,
        minVersion: 'TLSv1.2',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout efter ${timeoutMs} ms mot Skatteverkets token-endpoint`))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

export class SkvTokenError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly responseBody?: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'SkvTokenError'
  }
}
