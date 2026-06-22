import 'server-only'

export type BolagsverketEnvironment = 'accept2' | 'production'

export type BolagsverketConfig = {
  environment: BolagsverketEnvironment
  tokenUrl: string
  apiBaseUrl: string
  clientId: string
  clientSecret: string
  scopes: string
  authMethod: 'basic' | 'post'
  timeoutMs: number
}

const PRODUCTION_TOKEN_URL = 'https://portal.api.bolagsverket.se/oauth2/token'
const PRODUCTION_API_BASE_URL = 'https://gw.api.bolagsverket.se/vardefulla-datamangder/v1'
const DEFAULT_SCOPES = 'vardefulla-datamangder:read vardefulla-datamangder:ping'
const DEFAULT_TIMEOUT_MS = 12_000

function clean(value: string | undefined | null): string | null {
  const trimmed = value?.trim()
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

export function getBolagsverketConfig(): BolagsverketConfig | null {
  const env = environment()
  const clientId = envValue('BOLAGSVERKET_CLIENT_ID', env)
  const clientSecret = envValue('BOLAGSVERKET_CLIENT_SECRET', env)

  if (!clientId || !clientSecret) return null

  const tokenUrl = cleanUrl(envValue('BOLAGSVERKET_TOKEN_URL', env))
    ?? (env === 'production' ? PRODUCTION_TOKEN_URL : null)
  const apiBaseUrl = cleanUrl(envValue('BOLAGSVERKET_API_BASE_URL', env))
    ?? (env === 'production' ? PRODUCTION_API_BASE_URL : null)

  if (!tokenUrl || !apiBaseUrl) return null

  const authMethod = clean(process.env.BOLAGSVERKET_AUTH_METHOD)?.toLowerCase() === 'post'
    ? 'post'
    : 'basic'
  const timeoutMs = Number.parseInt(process.env.BOLAGSVERKET_TIMEOUT_MS ?? '', 10)

  return {
    environment: env,
    tokenUrl,
    apiBaseUrl,
    clientId,
    clientSecret,
    scopes: clean(process.env.BOLAGSVERKET_SCOPES) ?? DEFAULT_SCOPES,
    authMethod,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1_000 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  }
}
