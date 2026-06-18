import 'server-only'

import { createHmac, timingSafeEqual } from 'crypto'
import type { CompanyRegistryLookup } from './provider'

const MAX_AGE_MS = 10 * 60 * 1000

type AttestedLookup = {
  provider: 'bolagsverket'
  issuedAt: number
  company: Pick<CompanyRegistryLookup, 'organizationNumber' | 'companyName' | 'legalForm' | 'registryStatus' | 'address' | 'sniCodes' | 'retrievedAt' | 'sourcePayload'>
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

export function signCompanyLookup(company: AttestedLookup['company']): string {
  const payload = encode({ provider: 'bolagsverket', issuedAt: Date.now(), company } satisfies AttestedLookup)
  return `${payload}.${sign(payload)}`
}

export function verifyCompanyLookup(token: string | null | undefined): AttestedLookup | null {
  if (!token || token.length > 12_000) return null
  const [payload, signature, ...extra] = token.split('.')
  if (!payload || !signature || extra.length) return null

  const expected = sign(payload)
  const actual = Buffer.from(signature)
  const expectedBytes = Buffer.from(expected)
  if (actual.length !== expectedBytes.length || !timingSafeEqual(actual, expectedBytes)) return null

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AttestedLookup
    if (decoded.provider !== 'bolagsverket' || !decoded.company || Date.now() - decoded.issuedAt > MAX_AGE_MS || decoded.issuedAt > Date.now() + 60_000) return null
    return decoded
  } catch {
    return null
  }
}
