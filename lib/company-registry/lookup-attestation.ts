import 'server-only'

import { createHmac, timingSafeEqual } from 'crypto'
import type { CompanyRegistryLookup } from './provider'
import { publicLookupPayload } from './registry-service'

const MAX_AGE_MS = 10 * 60 * 1000
const MAX_TOKEN_LENGTH = 8_000

type AttestedCompany = ReturnType<typeof publicLookupPayload>

type AttestedLookup = {
  provider: 'bolagsverket'
  issuedAt: number
  company: AttestedCompany
}

function secret() {
  const value = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!value) throw new Error('Missing server signing secret')
  return value
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function sign(payload: string) {
  return createHmac('sha256', secret()).update(payload).digest('base64url')
}

/**
 * Signs only the normalized, public-safe registry fields used by signup.
 * Raw Bolagsverket payloads can be large and should stay server-side; settings
 * sync can fetch and store the full snapshot later under company context.
 */
export function signCompanyLookup(company: CompanyRegistryLookup): string {
  const payload = encode({
    provider: 'bolagsverket',
    issuedAt: Date.now(),
    company: publicLookupPayload(company),
  } satisfies AttestedLookup)
  return `${payload}.${sign(payload)}`
}

export function verifyCompanyLookup(token: string | null | undefined): AttestedLookup | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null
  const [payload, signature, ...extra] = token.split('.')
  if (!payload || !signature || extra.length) return null

  const expected = sign(payload)
  const actual = Buffer.from(signature)
  const expectedBytes = Buffer.from(expected)
  if (actual.length !== expectedBytes.length || !timingSafeEqual(actual, expectedBytes)) return null

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AttestedLookup
    if (
      decoded.provider !== 'bolagsverket'
      || !decoded.company
      || Date.now() - decoded.issuedAt > MAX_AGE_MS
      || decoded.issuedAt > Date.now() + 60_000
    ) return null
    return decoded
  } catch {
    return null
  }
}
