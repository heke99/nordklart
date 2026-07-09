/**
 * BankID consent-service lifecycle: atomic completion (consent BEFORE
 * session flip), idempotent replays, self-heal for legacy orphaned sessions,
 * cancel semantics, revoke auditing, keyed personnummer hashing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.BANKID_HASH_SECRET = 'test-hash-secret'

type Row = Record<string, unknown>

const state: {
  session: Row | null
  consent: Row | null
  consentInsertError: { code?: string; message: string } | null
  sessionUpdates: Row[]
  consentInserts: Row[]
  auditInserts: Row[]
  revokeResult: Row | null
} = {
  session: null,
  consent: null,
  consentInsertError: null,
  sessionUpdates: [],
  consentInserts: [],
  auditInserts: [],
  revokeResult: null,
}

const collectMock = vi.fn()
const cancelMock = vi.fn()
const startSignMock = vi.fn()
vi.mock('@/lib/auth/bankid-provider', () => ({
  getBankIdProvider: () => ({
    id: 'mock',
    mode: 'test',
    startSign: (...args: unknown[]) => startSignMock(...args),
    collect: (...args: unknown[]) => collectMock(...args),
    cancel: (...args: unknown[]) => cancelMock(...args),
  }),
}))

const markSignatureSignedMock = vi.fn()
vi.mock('@/lib/bokslut/arsredovisning/signature-service', () => ({
  markSignatureSigned: (...args: unknown[]) => markSignatureSignedMock(...args),
}))

function makeSupabase() {
  return {
    from: (table: string) => {
      if (table === 'bankid_sessions') {
        return {
          select() { return this },
          eq() { return this },
          maybeSingle: async () => ({ data: state.session, error: null }),
          insert: (row: Row) => ({
            select: () => ({ single: async () => ({ data: { id: 'session-1', ...row }, error: null }) }),
          }),
          update(row: Row) {
            state.sessionUpdates.push(row)
            const chain = {
              eq: () => chain,
              select: async () => ({ data: [{ id: 'session-1' }], error: null }),
              then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
            }
            return chain
          },
        }
      }
      if (table === 'signed_consents') {
        return {
          select() { return this },
          eq() { return this },
          maybeSingle: async () => ({ data: state.consent, error: null }),
          insert: (row: Row) => {
            state.consentInserts.push(row)
            return {
              select: () => ({
                single: async () =>
                  state.consentInsertError
                    ? { data: null, error: state.consentInsertError }
                    : { data: { id: 'consent-1' }, error: null },
              }),
            }
          },
          update(_row: Row) {
            const chain = {
              eq: () => chain,
              select: () => ({ maybeSingle: async () => ({ data: state.revokeResult, error: null }) }),
            }
            return chain
          },
        }
      }
      if (table === 'audit_log') {
        return {
          insert: (row: Row) => {
            state.auditInserts.push(row)
            return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  } as never
}

import {
  startConsentSigning,
  pollConsentSession,
  cancelConsentSession,
  revokeConsent,
} from '@/lib/auth/consent-service'
import { hashPersonalNumberHmac, hashPersonalNumber } from '@/lib/auth/bankid'

const pendingSession = {
  id: 'session-1',
  company_id: 'company-1',
  user_id: 'user-1',
  provider_session_ref: 'ref-1',
  status: 'pending',
  sign_text: 'Jag godkänner att…',
  context: { consent_type: 'skatteverket', title: 'Skatteverket-flöden' },
}

describe('consent-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.session = null
    state.consent = null
    state.consentInsertError = null
    state.sessionUpdates.length = 0
    state.consentInserts.length = 0
    state.auditInserts.length = 0
    state.revokeResult = null
    startSignMock.mockResolvedValue({ sessionRef: 'ref-1', autoStartToken: 'ast', qrStartToken: 'qst', qrStartSecret: 'qss', expiresAt: null })
    collectMock.mockResolvedValue({ status: 'pending', hintCode: 'outstandingTransaction' })
    cancelMock.mockResolvedValue(undefined)
  })

  it('start creates the session and audits the start event', async () => {
    const result = await startConsentSigning(makeSupabase(), {
      companyId: 'company-1',
      userId: 'user-1',
      consentType: 'skatteverket',
      title: 'Skatteverket-flöden',
      consentText: 'Jag godkänner att…',
      endUserIp: '203.0.113.7',
    })
    expect(result.sessionId).toBe('session-1')
    expect(state.auditInserts.some((a) => String(a.description).includes('startad'))).toBe(true)
  })

  it('poll pending returns pending without any writes', async () => {
    state.session = { ...pendingSession }
    const result = await pollConsentSession(makeSupabase(), { sessionId: 'session-1', userId: 'user-1' })
    expect(result.status).toBe('pending')
    expect(state.consentInserts).toHaveLength(0)
    expect(state.sessionUpdates).toHaveLength(0)
  })

  it('poll complete creates the consent BEFORE the session flips and uses the HMAC hash', async () => {
    state.session = { ...pendingSession }
    collectMock.mockResolvedValue({
      status: 'complete',
      hintCode: null,
      user: { personalNumber: '190001019802', name: 'Test Testsson', givenName: 'Test', surname: 'Testsson' },
      completedAt: '2026-07-01T10:00:00Z',
    })

    const result = await pollConsentSession(makeSupabase(), { sessionId: 'session-1', userId: 'user-1' })

    expect(result.status).toBe('complete')
    expect(result.consentId).toBe('consent-1')
    expect(state.consentInserts).toHaveLength(1)
    // Keyed hash, never the plain SHA-256.
    expect(state.consentInserts[0].personal_number_hash).toBe(hashPersonalNumberHmac('190001019802'))
    expect(state.consentInserts[0].personal_number_hash).not.toBe(hashPersonalNumber('190001019802'))
    // No plaintext personnummer anywhere in the stored rows.
    expect(JSON.stringify(state.consentInserts[0])).not.toContain('190001019802')
    expect(JSON.stringify(state.sessionUpdates)).not.toContain('190001019802')
    // Session flip happened after (and only after) the consent existed.
    expect(state.sessionUpdates.some((u) => u.status === 'complete')).toBe(true)
  })

  it('never reports complete without a consent id when the insert fails', async () => {
    state.session = { ...pendingSession }
    state.consentInsertError = { message: 'insert blocked' }
    collectMock.mockResolvedValue({
      status: 'complete',
      hintCode: null,
      user: { personalNumber: '190001019802', name: 'Test Testsson', givenName: 'Test', surname: 'Testsson' },
    })

    await expect(pollConsentSession(makeSupabase(), { sessionId: 'session-1', userId: 'user-1' })).rejects.toThrow(/samtycket kunde inte sparas/)
    // The session was NOT flipped to complete — the next poll retries the whole completion.
    expect(state.sessionUpdates.some((u) => u.status === 'complete')).toBe(false)
  })

  it('reuses the existing consent when a concurrent poll already created it (23505)', async () => {
    state.session = { ...pendingSession }
    state.consentInsertError = { code: '23505', message: 'duplicate key' }
    state.consent = { id: 'consent-existing' }
    collectMock.mockResolvedValue({
      status: 'complete',
      hintCode: null,
      user: { personalNumber: '190001019802', name: 'Test Testsson', givenName: 'Test', surname: 'Testsson' },
    })

    const result = await pollConsentSession(makeSupabase(), { sessionId: 'session-1', userId: 'user-1' })
    expect(result).toMatchObject({ status: 'complete', consentId: 'consent-existing' })
  })

  it('self-heals a legacy complete session that lost its consent row', async () => {
    state.session = {
      ...pendingSession,
      status: 'complete',
      personal_number_hash: 'legacy-hash',
      personal_number_masked: 'XXXXXXXX-9802',
      signer_name: 'Test Testsson',
      completed_at: '2026-06-01T10:00:00Z',
    }
    state.consent = null // no consent row for the completed session

    const result = await pollConsentSession(makeSupabase(), { sessionId: 'session-1', userId: 'user-1' })
    expect(result.status).toBe('complete')
    expect(result.consentId).toBe('consent-1')
    expect(state.consentInserts).toHaveLength(1)
    expect(state.consentInserts[0].personal_number_hash).toBe('legacy-hash')
  })

  it('poll of a completed session with existing consent is a pure read', async () => {
    state.session = { ...pendingSession, status: 'complete' }
    state.consent = { id: 'consent-1' }
    const result = await pollConsentSession(makeSupabase(), { sessionId: 'session-1', userId: 'user-1' })
    expect(result).toMatchObject({ status: 'complete', consentId: 'consent-1' })
    expect(state.consentInserts).toHaveLength(0)
  })

  it('audits failed/cancelled provider outcomes', async () => {
    state.session = { ...pendingSession }
    collectMock.mockResolvedValue({ status: 'failed', hintCode: 'expiredTransaction' })
    const result = await pollConsentSession(makeSupabase(), { sessionId: 'session-1', userId: 'user-1' })
    expect(result.status).toBe('failed')
    expect(state.auditInserts.some((a) => String(a.description).includes('misslyckades'))).toBe(true)
  })

  it('cancel cancels a pending session at the provider and audits it', async () => {
    state.session = { ...pendingSession }
    const result = await cancelConsentSession(makeSupabase(), { sessionId: 'session-1', userId: 'user-1' })
    expect(result.status).toBe('cancelled')
    expect(cancelMock).toHaveBeenCalledWith('ref-1')
    expect(state.sessionUpdates.some((u) => u.status === 'cancelled')).toBe(true)
    expect(state.auditInserts.some((a) => String(a.description).includes('avbruten'))).toBe(true)
  })

  it('cannot cancel a completed session', async () => {
    state.session = { ...pendingSession, status: 'complete' }
    await expect(cancelConsentSession(makeSupabase(), { sessionId: 'session-1', userId: 'user-1' })).rejects.toThrow(/redan slutförd/)
    expect(cancelMock).not.toHaveBeenCalled()
  })

  it('cancel is idempotent for already-cancelled sessions', async () => {
    state.session = { ...pendingSession, status: 'cancelled' }
    const result = await cancelConsentSession(makeSupabase(), { sessionId: 'session-1', userId: 'user-1' })
    expect(result.status).toBe('already_cancelled')
  })

  it('revoke flips status and audits', async () => {
    state.revokeResult = { id: 'consent-1', consent_type: 'skatteverket', title: 'Skatteverket-flöden' }
    await revokeConsent(makeSupabase(), { consentId: 'consent-1', companyId: 'company-1', userId: 'user-1' })
    expect(state.auditInserts.some((a) => String(a.description).includes('återkallat'))).toBe(true)
  })

  it('revoke of an unknown/already-revoked consent throws', async () => {
    state.revokeResult = null
    await expect(revokeConsent(makeSupabase(), { consentId: 'x', companyId: 'company-1', userId: 'user-1' })).rejects.toThrow(/redan återkallat|hittas/)
  })
})
