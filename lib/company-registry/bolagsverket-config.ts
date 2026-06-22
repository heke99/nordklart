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
  apiBaseUrlHost: string | null
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

function clean(value: string | undefined | null): string | null {
  const trimmed = value?.trim().replace(/^['"]|['"]$/g, '')
  return trimmed ? trimmed : null
}

function cleanUrl(value: string | null): string | null {
  return value?.replace(/\.+$/, '').replace(/\/+$/, '') ?? null
}

function environment(): BolagsverketEnvironment {
  const value = clean(process.env.BOLAGSVERKET_ENVIRONMENT)?.toLowerCase()
  return value === 'accept2' ? 'accept2' : 'production'
}

function envValue(name: string, env: BolagsverketEnvironment): string | null {
  const suffix = env === 'production' ? 'PRODUCTION' : 'ACCEPT2'
  return clean(process.env[`${name}_${suffix}`]) ?? clean(process.env[name])
}

function cleanScopes(value: string | null): string {
  const configuredScopes = (value ?? DEFAULT_SCOPES)
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .split(/\s+/)
    .filter(Boolean)

  const scopeSet = new Set(configuredScopes)
  for (const scope of REQUIRED_SCOPES) scopeSet.add(scope)

  return Array.from(scopeSet).join(' ')
}

function cleanAuthMethod(): BolagsverketAuthMethod {
  const value = clean(process.env.BOLAGSVERKET_AUTH_METHOD)?.toLowerCase()
  if (value === 'basic' || value === 'auto') return value
  return 'post'
}

function hostFromUrl(value: string | null): string | null {
  if (!value) return null
  try {
    return new URL(value).host
  } catch {
    return null
  }
}

export function getBolagsverketConfig(): BolagsverketConfig | null {
  const env = environment()
  const clientId = envValue('BOLAGSVERKET_CLIENT_ID', env)
  const clientSecret = envValue('BOLAGSVERKET_CLIENT_SECRET', env)

  if (!clientId || !clientSecret) return null

  const tokenUrl = cleanUrl(envValue('BOLAGSVERKET_TOKEN_URL', env))
    ?? (env === 'production' ? PRODUCTION_TOKEN_URL : ACCEPT2_TOKEN_URL)
  const apiBaseUrl = cleanUrl(envValue('BOLAGSVERKET_API_BASE_URL', env))
    ?? (env === 'production' ? PRODUCTION_API_BASE_URL : ACCEPT2_API_BASE_URL)

  if (!tokenUrl || !apiBaseUrl) return null

  const timeoutMs = Number.parseInt(process.env.BOLAGSVERKET_TIMEOUT_MS ?? '', 10)

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
  const tokenUrl = cleanUrl(envValue('BOLAGSVERKET_TOKEN_URL', env))
    ?? (env === 'production' ? PRODUCTION_TOKEN_URL : ACCEPT2_TOKEN_URL)
  const apiBaseUrl = cleanUrl(envValue('BOLAGSVERKET_API_BASE_URL', env))
    ?? (env === 'production' ? PRODUCTION_API_BASE_URL : ACCEPT2_API_BASE_URL)

  return {
    configured: Boolean(config),
    environment: env,
    authMethod: config?.authMethod ?? cleanAuthMethod(),
    tokenUrlHost: hostFromUrl(config?.tokenUrl ?? tokenUrl),
    apiBaseUrlHost: hostFromUrl(config?.apiBaseUrl ?? apiBaseUrl),
    scopes: cleanScopes(envValue('BOLAGSVERKET_SCOPES', env)).split(' '),
    hasClientId: Boolean(envValue('BOLAGSVERKET_CLIENT_ID', env)),
    hasClientSecret: Boolean(envValue('BOLAGSVERKET_CLIENT_SECRET', env)),
  }
}
