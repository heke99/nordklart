import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { evaluateFounder, isActiveRepresentative, encryptedPersonalNumberToBuffer } from '../verify-signatory'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'

const now = new Date('2026-09-25T12:00:00Z')
const PNR = '198001011231'
const ORG = '5560125790'

function role(overrides: Partial<EnrichmentCompanyRole> = {}): EnrichmentCompanyRole {
  return {
    companyId: 1,
    companyRegistrationNumber: '556012-5790',
    legalName: 'Test AB',
    legalEntityType: 'AB',
    positionTypes: ['boardMember'],
    positionDescriptions: ['Styrelseledamot'],
    positionStart: '2020-01-01',
    positionEnd: null,
    companyStatus: 'active',
    ...overrides,
  }
}

const ab = (roles: EnrichmentCompanyRole[], enrichedAt: string | null = '2026-09-20T00:00:00Z', orgNumber: string | null = ORG) =>
  evaluateFounder({ entityType: 'aktiebolag', orgNumber, personalNumber: PNR, companyRoles: roles, enrichedAt, now })

describe('evaluateFounder — aktiebolag', () => {
  it.each([
    [['boardMember'], ['Styrelseledamot']],
    [['ceo'], ['Verkställande direktör']],
    [['chairman'], ['Ordförande']],
    [['externalSignatory'], ['Extern firmatecknare']],
    [['LED'], ['Styrelseledamot']],
  ])('verifies an active %s', (types, descriptions) => {
    expect(ab([role({ positionTypes: types, positionDescriptions: descriptions })]).status).toBe('verified')
  })

  it.each([
    [['deputyBoardMember'], ['Styrelsesuppleant']],
    [['deputyCeo'], ['Vice verkställande direktör']],
    [['auditor'], ['Revisor']],
  ])('sends %s to manual review', (types, descriptions) => {
    const result = ab([role({ positionTypes: types, positionDescriptions: descriptions })])
    expect(result.status).toBe('manual_review')
    expect(result.reason).toBe('ab_role_not_representative')
  })

  it('rejects an ended position', () => {
    expect(ab([role({ positionEnd: '2026-01-01' })]).status).toBe('manual_review')
  })

  it('rejects a role in a different company', () => {
    const result = ab([role({ companyRegistrationNumber: '5569999999' })])
    expect(result.reason).toBe('ab_no_role_in_company')
  })

  it('rejects stale or missing enrichment', () => {
    expect(ab([role()], '2026-07-01T00:00:00Z').reason).toBe('ab_roles_stale')
    expect(ab([role()], null).reason).toBe('ab_roles_stale')
  })

  it('requires an org.nr for an aktiebolag', () => {
    expect(ab([role()], '2026-09-20T00:00:00Z', null).reason).toBe('ab_missing_org_number')
  })

  it('matches 12-digit org.nr with the 16 prefix', () => {
    expect(ab([role()], '2026-09-20T00:00:00Z', '165560125790').status).toBe('verified')
  })
})

describe('evaluateFounder — enskild firma', () => {
  const ef = (orgNumber: string | null) =>
    evaluateFounder({ entityType: 'enskild_firma', orgNumber, personalNumber: PNR, companyRoles: [], enrichedAt: null, now })

  it('verifies when org.nr is the BankID personnummer', () => {
    expect(ef('800101-1231').status).toBe('verified')
  })

  it('sends another person\'s personnummer to manual review', () => {
    expect(ef('8112189876').status).toBe('manual_review')
  })

  it('verifies a firm registered without org.nr', () => {
    expect(ef(null).status).toBe('verified')
  })
})

describe('isActiveRepresentative', () => {
  it('ignores a position that has not started', () => {
    expect(isActiveRepresentative(role({ positionStart: '2027-01-01' }), now)).toBe(false)
  })
})

describe('encryptedPersonalNumberToBuffer', () => {
  it('decodes a hex bytea', () => {
    expect(encryptedPersonalNumberToBuffer('\\x0102ff')).toEqual(Buffer.from([1, 2, 255]))
  })

  it('decodes a JSON-serialised Buffer stored as bytea', () => {
    const json = JSON.stringify(Buffer.from([7, 8, 9]))
    const hex = '\\x' + Buffer.from(json, 'utf8').toString('hex')
    expect(encryptedPersonalNumberToBuffer(hex)).toEqual(Buffer.from([7, 8, 9]))
  })
})

describe('checkSignerAgainstRegistry', () => {
  function service(tables: Record<string, unknown>) {
    return {
      from: (t: string) => {
        const q: Record<string, unknown> = {}
        for (const m of ['select', 'eq']) q[m] = () => q
        q.maybeSingle = async () => ({ data: tables[t] ?? null, error: null })
        return q
      },
    } as never
  }

  it('matches the account holder who is a registered board member', async () => {
    const { checkSignerAgainstRegistry } = await import('../verify-signatory')
    const result = await checkSignerAgainstRegistry(service({
      companies: { org_number: ORG },
      bankid_identities: { personal_number_hash: 'h1' },
      bankid_enrichment: { company_roles: [role()], enriched_at_utc: '2026-09-20T00:00:00Z' },
    }), { userId: 'u', companyId: 'c', signerPersonalNumberHash: 'h1', now })
    expect(result.matched).toBe(true)
  })

  it('reports a signature by another person\'s BankID', async () => {
    const { checkSignerAgainstRegistry } = await import('../verify-signatory')
    const result = await checkSignerAgainstRegistry(service({
      companies: { org_number: ORG },
      bankid_identities: { personal_number_hash: 'h1' },
    }), { userId: 'u', companyId: 'c', signerPersonalNumberHash: 'other', now })
    expect(result).toEqual({ matched: false, reason: 'signer_not_account_holder' })
  })
})
