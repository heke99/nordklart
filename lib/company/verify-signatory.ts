import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptPersonalNumber, isBankIdEnabled } from '@/lib/auth/bankid'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'

/**
 * Who may register a company in Nordklart.
 *
 * A company's books are its legal records (BFL), so the person who creates
 * the workspace becomes its owner and decides who else gets in. On hosted
 * Nordklart that person must have identified with BankID, and we check the
 * identity against the company:
 *
 *  - Aktiebolag: the BankID holder must currently hold a position that
 *    represents the company in Bolagsverket's register — styrelseledamot,
 *    ordförande, verkställande direktör or extern firmatecknare. The roles
 *    come from TIC Identity's enrichment of the BankID session (Bolagsverket
 *    data, stored server-side in bankid_enrichment; nothing the browser sends
 *    is trusted). Suppleanter, vice VD and revisorer are not enough on their
 *    own.
 *  - Enskild firma: the proprietor IS the firm; the org.nr of an enskild
 *    firma is the owner's personnummer. It must match the BankID personnummer.
 *
 * No match does not block the user: the company is created with the founder
 * as 'active_limited' + verification_status 'manual_review' (read access, no
 * writes) until a platform admin verifies. Self-hosted installs, and hosted
 * installs with BankID switched off, keep the previous self-attested model.
 */

export type FounderVerificationStatus = 'verified' | 'manual_review' | 'self_attested'

export type FounderVerification =
  | { kind: 'bankid_required' }
  | {
      kind: 'decided'
      status: FounderVerificationStatus
      reason: string
      evidence: Record<string, unknown>
    }

/** Positions that represent an aktiebolag towards third parties. */
const REPRESENTATIVE_POSITION_TYPES = new Set([
  'ceo',
  'boardmember',
  'chairman',
  'externalsignatory',
  'externalceo',
  // Bolagsverket's own codes, as some TIC payloads carry them.
  'vd',
  'evd',
  'le',
  'led',
  'of',
  'eft',
])

const REPRESENTATIVE_DESCRIPTION = /(styrelseledamot|ordförande|verkställande direktör|firmatecknare)/i
const NON_REPRESENTATIVE_DESCRIPTION = /(suppleant|vice\s+verkställande|revisor)/i

/** An enrichment older than this is not trusted to reflect today's register. */
export const ENRICHMENT_MAX_AGE_DAYS = 30

function positionRepresents(type: string | undefined, description: string | undefined): boolean {
  const t = (type ?? '').replace(/[\s_-]/g, '').toLowerCase()
  const d = description ?? ''
  if (NON_REPRESENTATIVE_DESCRIPTION.test(d)) return false
  return REPRESENTATIVE_POSITION_TYPES.has(t) || REPRESENTATIVE_DESCRIPTION.test(d)
}

export function isActiveRepresentative(role: EnrichmentCompanyRole, now: Date): boolean {
  if (role.positionEnd && new Date(role.positionEnd) <= now) return false
  if (role.positionStart && new Date(role.positionStart) > now) return false
  const types = role.positionTypes ?? []
  const descriptions = role.positionDescriptions ?? []
  const n = Math.max(types.length, descriptions.length)
  for (let i = 0; i < n; i++) {
    if (positionRepresents(types[i], descriptions[i])) return true
  }
  return false
}

/** Pure decision. `personalNumber` is the 12-digit BankID personnummer. */
export function evaluateFounder(params: {
  entityType: 'aktiebolag' | 'enskild_firma'
  orgNumber: string | null
  personalNumber: string
  companyRoles: EnrichmentCompanyRole[]
  enrichedAt: string | null
  now: Date
}): Extract<FounderVerification, { kind: 'decided' }> {
  const org = normalizeOrgNumber(params.orgNumber)
  const pnr10 = params.personalNumber.replace(/\D/g, '').slice(-10)

  if (params.entityType === 'enskild_firma') {
    if (!org) {
      // No org.nr given: the firm is the BankID holder's own.
      return { kind: 'decided', status: 'verified', reason: 'ef_bankid_holder', evidence: { method: 'bankid' } }
    }
    return org === pnr10
      ? { kind: 'decided', status: 'verified', reason: 'ef_personnummer_match', evidence: { method: 'bankid_personnummer' } }
      : { kind: 'decided', status: 'manual_review', reason: 'ef_personnummer_mismatch', evidence: { method: 'bankid_personnummer' } }
  }

  if (!org) {
    return { kind: 'decided', status: 'manual_review', reason: 'ab_missing_org_number', evidence: {} }
  }

  const enrichedAt = params.enrichedAt ? new Date(params.enrichedAt) : null
  const maxAgeMs = ENRICHMENT_MAX_AGE_DAYS * 86_400_000
  if (!enrichedAt || params.now.getTime() - enrichedAt.getTime() > maxAgeMs) {
    return { kind: 'decided', status: 'manual_review', reason: 'ab_roles_stale', evidence: { enriched_at: params.enrichedAt } }
  }

  const matches = params.companyRoles.filter((r) => normalizeOrgNumber(r.companyRegistrationNumber) === org)
  const representative = matches.find((r) => isActiveRepresentative(r, params.now))
  if (!representative) {
    return {
      kind: 'decided',
      status: 'manual_review',
      reason: matches.length > 0 ? 'ab_role_not_representative' : 'ab_no_role_in_company',
      evidence: { enriched_at: params.enrichedAt, positions: matches.flatMap((r) => r.positionDescriptions ?? []) },
    }
  }

  return {
    kind: 'decided',
    status: 'verified',
    reason: 'ab_registered_representative',
    evidence: {
      method: 'bankid_tic_company_roles',
      enriched_at: params.enrichedAt,
      positions: representative.positionDescriptions ?? representative.positionTypes ?? [],
      legal_name: representative.legalName,
    },
  }
}

/**
 * Load the BankID identity and company roles for `userId` (service client —
 * both tables are server-written only) and decide.
 */
export async function verifyFounder(
  service: SupabaseClient,
  params: { userId: string; entityType: 'aktiebolag' | 'enskild_firma'; orgNumber: string | null; now?: Date },
): Promise<FounderVerification> {
  if (!isBankIdEnabled()) {
    return { kind: 'decided', status: 'self_attested', reason: 'bankid_disabled', evidence: {} }
  }

  const [{ data: identity, error: identityError }, { data: enrichment, error: enrichmentError }] = await Promise.all([
    service.from('bankid_identities').select('personal_number_enc').eq('user_id', params.userId).maybeSingle(),
    service.from('bankid_enrichment').select('company_roles, enriched_at_utc').eq('user_id', params.userId).maybeSingle(),
  ])
  if (identityError || enrichmentError) {
    throw new Error('Kunde inte läsa BankID-identiteten.')
  }
  if (!identity?.personal_number_enc) return { kind: 'bankid_required' }

  const personalNumber = decryptPersonalNumber(encryptedPersonalNumberToBuffer(identity.personal_number_enc))
  return evaluateFounder({
    entityType: params.entityType,
    orgNumber: params.orgNumber,
    personalNumber,
    companyRoles: Array.isArray(enrichment?.company_roles) ? (enrichment!.company_roles as EnrichmentCompanyRole[]) : [],
    enrichedAt: (enrichment?.enriched_at_utc as string | null) ?? null,
    now: params.now ?? new Date(),
  })
}

/**
 * bytea comes back from PostgREST as a '\x…' hex string. The link handler
 * inserts a Node Buffer through supabase-js, which JSON-serialises it as
 * {"type":"Buffer","data":[…]}; PostgREST then stores that JSON text's bytes.
 * Accept both shapes so every existing row decrypts.
 */
export function encryptedPersonalNumberToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (typeof value !== 'string') throw new Error('Okänt format på krypterat personnummer.')
  const raw = value.startsWith('\\x') ? Buffer.from(value.slice(2), 'hex') : Buffer.from(value, 'base64')
  const text = raw.toString('utf8')
  if (text.startsWith('{"type":"Buffer"')) {
    const parsed = JSON.parse(text) as { data: number[] }
    return Buffer.from(parsed.data)
  }
  return raw
}

export type SignerRegistryCheck =
  | { matched: true; positions: string[] }
  | { matched: false; reason: 'signer_not_account_holder' | 'no_registry_data' | 'roles_stale' | 'no_representative_role' | 'company_without_org_number' }

/**
 * Does the person who just BankID-signed an årsredovisning hold a position
 * that must sign it (ÅRL 2 kap. 7 §: every styrelseledamot and the VD)? We
 * only hold Bolagsverket roles for the account holder (bankid_enrichment), so
 * a signature by someone else's BankID on this account is reported as such.
 * Advisory: the result is stored with the signature evidence and surfaced as
 * a warning, never used to reject a signature.
 */
export async function checkSignerAgainstRegistry(
  service: SupabaseClient,
  params: { userId: string; companyId: string; signerPersonalNumberHash: string | null; now?: Date },
): Promise<SignerRegistryCheck> {
  const now = params.now ?? new Date()
  const [{ data: company }, { data: identity }, { data: enrichment }] = await Promise.all([
    service.from('companies').select('org_number').eq('id', params.companyId).maybeSingle(),
    service.from('bankid_identities').select('personal_number_hash').eq('user_id', params.userId).maybeSingle(),
    service.from('bankid_enrichment').select('company_roles, enriched_at_utc').eq('user_id', params.userId).maybeSingle(),
  ])
  const org = normalizeOrgNumber((company?.org_number as string | null) ?? null)
  if (!org) return { matched: false, reason: 'company_without_org_number' }
  if (!params.signerPersonalNumberHash || identity?.personal_number_hash !== params.signerPersonalNumberHash) {
    return { matched: false, reason: 'signer_not_account_holder' }
  }
  if (!enrichment) return { matched: false, reason: 'no_registry_data' }
  const enrichedAt = enrichment.enriched_at_utc ? new Date(enrichment.enriched_at_utc as string) : null
  if (!enrichedAt || now.getTime() - enrichedAt.getTime() > ENRICHMENT_MAX_AGE_DAYS * 86_400_000) {
    return { matched: false, reason: 'roles_stale' }
  }
  const roles = Array.isArray(enrichment.company_roles) ? (enrichment.company_roles as EnrichmentCompanyRole[]) : []
  const role = roles.find((r) => normalizeOrgNumber(r.companyRegistrationNumber) === org && isActiveRepresentative(r, now))
  return role
    ? { matched: true, positions: role.positionDescriptions ?? role.positionTypes ?? [] }
    : { matched: false, reason: 'no_representative_role' }
}
