import 'server-only'

export type BolagsverketEnvironment = 'accept2' | 'production'
export type BolagsverketAuthMethod = 'post' | 'basic' | 'auto'

export type BolagsverketConfig = {
  environment: BolagsverketEnvironment
  tokenUrl: string
  apiBaseUrl: string
  clientId: string
  clientSecret: string
  scopes: string
  authMethod: BolagsverketAuthMethod
  timeoutMs: number
}

export type BolagsverketConfigSummary = {
  configured: boolean
  environment: BolagsverketEnvironment
  authMethod: BolagsverketAuthMethod
  tokenUrlHost: string | null
  tokenUrlPath: string | null
  apiBaseUrlHost: string | null
  apiBaseUrlPath: string | null
  apiBaseUrlLooksValid: boolean
  scopes: string[]
  hasClientId: boolean
  hasClientSecret: boolean
}

const PRODUCTION_TOKEN_URL = 'https://portal.api.bolagsverket.se/oauth2/token'
const PRODUCTION_API_BASE_URL = 'https://gw.api.bolagsverket.se/vardefulla-datamangder/v1'
const ACCEPT2_TOKEN_URL = 'https://portal-accept2.api.bolagsverket.se/oauth2/token'
const ACCEPT2_API_BASE_URL = 'https://gw-accept2.api.bolagsverket.se/vardefulla-datamangder/v1'
const DEFAULT_SCOPES = 'vardefulla-datamangder:read vardefulla-datamangder:ping'
const REQUIRED_SCOPES = ['vardefulla-datamangder:read', 'vardefulla-datamangder:ping'] as const
const DEFAULT_TIMEOUT_MS = 12_000

function stripEnvAssignment(value: string, names: string[]): string {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '')
  for (const name of names) {
    const prefix = `${name}=`
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim().replace(/^['"]|['"]$/g, '')
  }
  return trimmed
}

function clean(value: string | undefined | null, names: string[] = []): string | null {
  if (value == null) return null
  const trimmed = stripEnvAssignment(value, names)
  return trimmed ? trimmed : null
}

function normalizeCopiedUrl(value: string): string {
  return value
    .replace(/[\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\s+/g, '')
}

function cleanUrl(value: string | null, names: string[] = []): string | null {
  const stripped = value ? stripEnvAssignment(value, names) : null
  if (!stripped) return null
  return normalizeCopiedUrl(stripped).replace(/\.+$/, '').replace(/\/+$/, '') || null
}

function environment(): BolagsverketEnvironment {
  const value = clean(process.env.BOLAGSVERKET_ENVIRONMENT, ['BOLAGSVERKET_ENVIRONMENT'])?.toLowerCase()
  return value === 'accept2' ? 'accept2' : 'production'
}

function envValue(name: string, env: BolagsverketEnvironment): string | null {
  const suffix = env === 'production' ? 'PRODUCTION' : 'ACCEPT2'
  const envSpecificName = `${name}_${suffix}`
  return clean(process.env[envSpecificName], [envSpecificName, name]) ?? clean(process.env[name], [name])
}

function cleanScopes(value: string | null): string {
  const configuredScopes = stripEnvAssignment(value ?? DEFAULT_SCOPES, ['BOLAGSVERKET_SCOPES'])
    .replace(/[,'"]/g, ' ')
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
    .filter((scope) => scope.includes(':'))

  const scopeSet = new Set(configuredScopes)
  for (const scope of REQUIRED_SCOPES) scopeSet.add(scope)

  return Array.from(scopeSet).join(' ')
}

function cleanAuthMethod(): BolagsverketAuthMethod {
  const value = clean(process.env.BOLAGSVERKET_AUTH_METHOD, ['BOLAGSVERKET_AUTH_METHOD'])?.toLowerCase()
  if (value === 'basic' || value === 'auto') return value
  return 'post'
}

function parsedUrl(value: string | null): URL | null {
  if (!value) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function hostFromUrl(value: string | null): string | null {
  return parsedUrl(value)?.host ?? null
}

function pathFromUrl(value: string | null): string | null {
  return parsedUrl(value)?.pathname ?? null
}

function apiBaseUrlLooksValid(value: string | null, env: BolagsverketEnvironment): boolean {
  const url = parsedUrl(value)
  if (!url) return false
  const expectedHost = env === 'production' ? 'gw.api.bolagsverket.se' : 'gw-accept2.api.bolagsverket.se'
  return url.protocol === 'https:'
    && url.host === expectedHost
    && url.pathname === '/vardefulla-datamangder/v1'
}

export function getBolagsverketConfig(): BolagsverketConfig | null {
  const env = environment()
  const clientId = envValue('BOLAGSVERKET_CLIENT_ID', env)
  const clientSecret = envValue('BOLAGSVERKET_CLIENT_SECRET', env)

  if (!clientId || !clientSecret) return null

  const tokenUrl = cleanUrl(envValue('BOLAGSVERKET_TOKEN_URL', env), ['BOLAGSVERKET_TOKEN_URL'])
    ?? (env === 'production' ? PRODUCTION_TOKEN_URL : ACCEPT2_TOKEN_URL)
  const apiBaseUrl = cleanUrl(envValue('BOLAGSVERKET_API_BASE_URL', env), ['BOLAGSVERKET_API_BASE_URL'])
    ?? (env === 'production' ? PRODUCTION_API_BASE_URL : ACCEPT2_API_BASE_URL)

  if (!tokenUrl || !apiBaseUrl) return null

  const timeoutMs = Number.parseInt(clean(process.env.BOLAGSVERKET_TIMEOUT_MS, ['BOLAGSVERKET_TIMEOUT_MS']) ?? '', 10)

  return {
    environment: env,
    tokenUrl,
    apiBaseUrl,
    clientId,
    clientSecret,
    scopes: cleanScopes(envValue('BOLAGSVERKET_SCOPES', env)),
    authMethod: cleanAuthMethod(),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1_000 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  }
}

export function getBolagsverketConfigSummary(): BolagsverketConfigSummary {
  const env = environment()
  const config = getBolagsverketConfig()
  const tokenUrl = cleanUrl(envValue('BOLAGSVERKET_TOKEN_URL', env), ['BOLAGSVERKET_TOKEN_URL'])
    ?? (env === 'production' ? PRODUCTION_TOKEN_URL : ACCEPT2_TOKEN_URL)
  const apiBaseUrl = cleanUrl(envValue('BOLAGSVERKET_API_BASE_URL', env), ['BOLAGSVERKET_API_BASE_URL'])
    ?? (env === 'production' ? PRODUCTION_API_BASE_URL : ACCEPT2_API_BASE_URL)

  return {
    configured: Boolean(config),
    environment: env,
    authMethod: config?.authMethod ?? cleanAuthMethod(),
    tokenUrlHost: hostFromUrl(config?.tokenUrl ?? tokenUrl),
    tokenUrlPath: pathFromUrl(config?.tokenUrl ?? tokenUrl),
    apiBaseUrlHost: hostFromUrl(config?.apiBaseUrl ?? apiBaseUrl),
    apiBaseUrlPath: pathFromUrl(config?.apiBaseUrl ?? apiBaseUrl),
    apiBaseUrlLooksValid: apiBaseUrlLooksValid(config?.apiBaseUrl ?? apiBaseUrl, env),
    scopes: cleanScopes(envValue('BOLAGSVERKET_SCOPES', env)).split(' '),
    hasClientId: Boolean(envValue('BOLAGSVERKET_CLIENT_ID', env)),
    hasClientSecret: Boolean(envValue('BOLAGSVERKET_CLIENT_SECRET', env)),
  }
}
