import 'server-only'

export type SkvEnvironment = 'test' | 'prod'
export type SkvServiceKey =
  | 'momsdeklaration'
  | 'agdInlamning'
  | 'agdPeriod'
  | 'ink1'
  | 'inkForetag'

export const SKV_DEFAULT_SCOPES = ['agd', 'ink1', 'inkforetag', 'momsdeklaration'] as const

const TEST_API_BASE = 'https://api.test.skatteverket.se'
const PROD_API_BASE = 'https://api.skatteverket.se'

const DEFAULT_SERVICE_BASE_URLS: Record<SkvEnvironment, Record<SkvServiceKey, string>> = {
  test: {
    momsdeklaration: `${TEST_API_BASE}/momsdeklaration/v1`,
    agdInlamning: `${TEST_API_BASE}/arbetsgivardeklaration/inlamning/v1`,
    agdPeriod: `${TEST_API_BASE}/arbetsgivardeklaration/hanteraredovisningsperiod/v1`,
    ink1: `${TEST_API_BASE}/privat/inkomstdeklaration/v1`,
    // Endpoint/version is kept configurable because INK2–4 API examples are only available
    // from Skatteverkets developer portal/RAML in the authenticated UI.
    inkForetag: `${TEST_API_BASE}/foretag/inkomstdeklaration/v1`,
  },
  prod: {
    momsdeklaration: `${PROD_API_BASE}/momsdeklaration/v1`,
    agdInlamning: `${PROD_API_BASE}/arbetsgivardeklaration/inlamning/v1`,
    agdPeriod: `${PROD_API_BASE}/arbetsgivardeklaration/hanteraredovisningsperiod/v1`,
    ink1: `${PROD_API_BASE}/privat/inkomstdeklaration/v1`,
    inkForetag: `${PROD_API_BASE}/foretag/inkomstdeklaration/v1`,
  },
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function boolEnv(...names: string[]): boolean {
  const value = firstEnv(...names)?.toLowerCase()
  return value === 'true' || value === '1' || value === 'yes' || value === 'on'
}

export function getSkvEnvironment(): SkvEnvironment {
  const value = firstEnv('SKV_ENV', 'SKATTEVERKET_ENV')?.toLowerCase()
  return value === 'prod' || value === 'production' ? 'prod' : 'test'
}

/** True when SKV_ENV/SKATTEVERKET_ENV is explicitly set (not defaulted). */
export function isSkvEnvironmentExplicit(): boolean {
  return Boolean(firstEnv('SKV_ENV', 'SKATTEVERKET_ENV'))
}

export function getSkvSysorgEnabled(): boolean {
  return boolEnv('SKV_SYSORG_ENABLED', 'SKV_ENABLED')
}

export function getSkvSysorgTokenUrl(): string {
  const explicit = firstEnv('SKV_SYSORG_TOKEN_URL', 'SKATTEVERKET_SYSORG_TOKEN_URL')
  if (explicit) return explicit
  return getSkvEnvironment() === 'prod'
    ? 'https://sysorgoauth2.skatteverket.se/oauth2/v1/sysorg/token'
    : 'https://sysorgoauth2.test.skatteverket.se/oauth2/v1/sysorg/token'
}

export function getSkvScopeString(): string {
  return firstEnv('SKV_SCOPES', 'SKATTEVERKET_SYSORG_SCOPES') ?? SKV_DEFAULT_SCOPES.join(' ')
}

export function getSkvServiceBaseUrl(service: SkvServiceKey): string {
  const env = getSkvEnvironment()
  const overrides: Partial<Record<SkvServiceKey, string | undefined>> = {
    momsdeklaration: firstEnv('SKV_MOMS_API_BASE_URL', 'SKATTEVERKET_API_BASE_URL'),
    agdInlamning: firstEnv('SKV_AGD_INLAMNING_API_BASE_URL', 'SKATTEVERKET_AGD_INLAMNING_API_BASE_URL'),
    agdPeriod: firstEnv('SKV_AGD_PERIOD_API_BASE_URL', 'SKATTEVERKET_AGD_PERIOD_API_BASE_URL'),
    ink1: firstEnv('SKV_INK1_API_BASE_URL', 'SKATTEVERKET_INK1_API_BASE_URL'),
    inkForetag: firstEnv('SKV_INKFORETAG_API_BASE_URL', 'SKATTEVERKET_INKFORETAG_API_BASE_URL'),
  }
  return overrides[service] ?? DEFAULT_SERVICE_BASE_URLS[env][service]
}

export function getSkvOAuthClientId(): string | undefined {
  return firstEnv('SKV_OAUTH_CLIENT_ID', 'SKATTEVERKET_OAUTH2_CLIENT_ID')
}

export function getSkvOAuthClientSecret(): string | undefined {
  return firstEnv('SKV_OAUTH_CLIENT_SECRET', 'SKATTEVERKET_OAUTH2_CLIENT_SECRET')
}

export function getSkvApiGwClientId(): string | undefined {
  return firstEnv('SKV_APIGW_CLIENT_ID', 'SKATTEVERKET_APIGW_CLIENT_ID')
}

export function getSkvApiGwClientSecret(): string | undefined {
  return firstEnv('SKV_APIGW_CLIENT_SECRET', 'SKATTEVERKET_APIGW_CLIENT_SECRET')
}

export function getSkvOrgCertBase64(): string | undefined {
  return firstEnv('SKV_ORG_CERT_P12_BASE64', 'SKATTEVERKET_ORG_CERT_P12_BASE64')
}

export function getSkvOrgCertPin(): string | undefined {
  return firstEnv('SKV_ORG_CERT_PIN', 'SKATTEVERKET_ORG_CERT_PIN')
}

export function getSkvRequestTimeoutMs(): number {
  const raw = firstEnv('SKV_REQUEST_TIMEOUT_MS', 'SKATTEVERKET_REQUEST_TIMEOUT_MS')
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 30_000
}

export function normalizeDigits(value: string): string {
  return value.replace(/\D/g, '')
}

export function toSkatteverketId(value: string, kind: 'organization' | 'person' = 'organization'): string {
  const digits = normalizeDigits(value)
  if (/^\d{12}$/.test(digits)) return digits
  if (!/^\d{10}$/.test(digits)) {
    throw new Error(`Ogiltigt id för Skatteverket: ${value} (förväntar 10 eller 12 siffror)`)
  }
  if (kind === 'organization') return `16${digits}`

  const year = Number(digits.slice(0, 2))
  const nowTwoDigitYear = new Date().getFullYear() % 100
  const century = year > nowTwoDigitYear ? '19' : '20'
  return `${century}${digits}`
}

export type SkvFilframstallare = {
  orgnr: string
  id: string
  name: string
  contactName: string
  contactEmail: string
  contactPhone: string | null
}

/**
 * Filframställare (file producer) identity sent to Skatteverket on every
 * sysorg filing. This is a LEGAL identity — it must ALWAYS come from
 * environment configuration and never from hardcoded defaults. (Earlier
 * versions silently fell back to a specific company's identity, which would
 * have attributed customer filings to the wrong legal entity in production.)
 *
 * Returns null when not configured; use getSkvFilframstallare() in flows
 * that must fail hard.
 */
export function getSkvFilframstallareOrNull(): SkvFilframstallare | null {
  const orgnr = firstEnv('SKV_FILFRAMSTALLARE_ORGNR', 'SKATTEVERKET_FILFRAMSTALLARE_ORGNR')
  const name = firstEnv('SKV_FILFRAMSTALLARE_NAME', 'SKATTEVERKET_FILFRAMSTALLARE_NAME')
  const contactEmail = firstEnv('SKV_FILFRAMSTALLARE_CONTACT_EMAIL', 'SKATTEVERKET_FILFRAMSTALLARE_CONTACT_EMAIL')
  if (!orgnr || !name || !contactEmail) return null
  return {
    orgnr,
    id: firstEnv('SKV_FILFRAMSTALLARE_ID', 'SKATTEVERKET_FILFRAMSTALLARE_ID') ?? toSkatteverketId(orgnr, 'organization'),
    name,
    contactName: firstEnv('SKV_FILFRAMSTALLARE_CONTACT_NAME', 'SKATTEVERKET_FILFRAMSTALLARE_CONTACT_NAME') ?? name,
    contactEmail,
    contactPhone: firstEnv('SKV_FILFRAMSTALLARE_CONTACT_PHONE', 'SKATTEVERKET_FILFRAMSTALLARE_CONTACT_PHONE') ?? null,
  }
}

export function getSkvFilframstallare(): SkvFilframstallare {
  const configured = getSkvFilframstallareOrNull()
  if (!configured) {
    throw new SkvConfigurationError(
      'Filframställare är inte konfigurerad. Sätt SKV_FILFRAMSTALLARE_ORGNR, SKV_FILFRAMSTALLARE_NAME och SKV_FILFRAMSTALLARE_CONTACT_EMAIL i miljövariablerna — identiteten skickas till Skatteverket och får aldrig hårdkodas.',
    )
  }
  return configured
}

/**
 * Fail-fast production guard for every sysorg flow (token + API requests).
 *
 * Throws SkvConfigurationError when the deployment cannot safely talk to
 * Skatteverket:
 *  - NODE_ENV=production requires an EXPLICIT SKV_ENV ('test' or 'prod') —
 *    silently defaulting a production deployment to Skatteverket's test API
 *    (or vice versa) must never happen.
 *  - The filframställare identity must be explicitly configured (no
 *    hardcoded fallback exists anymore).
 */
export function assertSkvProductionSafety(): void {
  const isProductionRuntime = process.env.NODE_ENV === 'production'
  const isProdEnvironment = getSkvEnvironment() === 'prod'
  if (!isProductionRuntime && !isProdEnvironment) return

  if (isProductionRuntime && !isSkvEnvironmentExplicit()) {
    throw new SkvConfigurationError(
      'SKV_ENV måste sättas explicit i produktion (test eller prod). Utan den skulle produktionsflöden tyst gå mot Skatteverkets testmiljö.',
    )
  }

  // Both a prod SKV environment and a production runtime require a real,
  // explicitly configured filframställare identity.
  getSkvFilframstallare()
}

export type SkvConfigCheck = {
  key: string
  label: string
  ok: boolean
  required: boolean
}

export function getSkvConfigStatus(): {
  environment: SkvEnvironment
  environmentExplicit: boolean
  enabled: boolean
  scopes: string[]
  filframstallare: SkvFilframstallare | null
  tokenUrl: string
  serviceBaseUrls: Record<SkvServiceKey, string>
  checks: SkvConfigCheck[]
  readyForTokenTest: boolean
  productionSafe: boolean
} {
  const serviceBaseUrls = {
    momsdeklaration: getSkvServiceBaseUrl('momsdeklaration'),
    agdInlamning: getSkvServiceBaseUrl('agdInlamning'),
    agdPeriod: getSkvServiceBaseUrl('agdPeriod'),
    ink1: getSkvServiceBaseUrl('ink1'),
    inkForetag: getSkvServiceBaseUrl('inkForetag'),
  }
  const filframstallare = getSkvFilframstallareOrNull()
  const checks: SkvConfigCheck[] = [
    { key: 'enabled', label: 'SKV_SYSORG_ENABLED/SKV_ENABLED', ok: getSkvSysorgEnabled(), required: true },
    { key: 'oauth_client_id', label: 'SKV_OAUTH_CLIENT_ID', ok: Boolean(getSkvOAuthClientId()), required: true },
    { key: 'oauth_client_secret', label: 'SKV_OAUTH_CLIENT_SECRET', ok: Boolean(getSkvOAuthClientSecret()), required: true },
    { key: 'apigw_client_id', label: 'SKV_APIGW_CLIENT_ID', ok: Boolean(getSkvApiGwClientId()), required: true },
    { key: 'apigw_client_secret', label: 'SKV_APIGW_CLIENT_SECRET', ok: Boolean(getSkvApiGwClientSecret()), required: true },
    { key: 'org_cert', label: 'SKV_ORG_CERT_P12_BASE64', ok: Boolean(getSkvOrgCertBase64()), required: true },
    { key: 'org_cert_pin', label: 'SKV_ORG_CERT_PIN', ok: Boolean(getSkvOrgCertPin()), required: true },
    { key: 'filframstallare', label: 'SKV_FILFRAMSTALLARE_ORGNR/_NAME/_CONTACT_EMAIL', ok: Boolean(filframstallare), required: true },
    { key: 'environment_explicit', label: 'SKV_ENV explicit satt', ok: isSkvEnvironmentExplicit(), required: process.env.NODE_ENV === 'production' },
  ]

  return {
    environment: getSkvEnvironment(),
    environmentExplicit: isSkvEnvironmentExplicit(),
    enabled: getSkvSysorgEnabled(),
    scopes: getSkvScopeString().split(/\s+/).filter(Boolean),
    filframstallare,
    tokenUrl: getSkvSysorgTokenUrl(),
    serviceBaseUrls,
    checks,
    readyForTokenTest: checks.every((check) => !check.required || check.ok),
    productionSafe: Boolean(filframstallare) && (process.env.NODE_ENV !== 'production' || isSkvEnvironmentExplicit()),
  }
}

export function requireSkvConfigValue(value: string | undefined, label: string): string {
  if (!value) throw new SkvConfigurationError(`${label} saknas i miljövariablerna. Lägg den i Vercel/Supabase secrets, inte i kod.`)
  return value
}

export class SkvConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkvConfigurationError'
  }
}
