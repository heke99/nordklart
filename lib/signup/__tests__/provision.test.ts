import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const mockFrom = vi.fn()
const mockRpc = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (...a: unknown[]) => mockFrom(...a), rpc: (...a: unknown[]) => mockRpc(...a) }),
}))

const mockVerifyFounder = vi.fn()
vi.mock('@/lib/company/verify-signatory', () => ({
  verifyFounder: (...a: unknown[]) => mockVerifyFounder(...a),
}))

import { provisionVerifiedSignupDraft } from '../provision'

function draftQuery(draft: unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'order', 'limit']) c[m] = vi.fn().mockReturnValue(c)
  c.maybeSingle = vi.fn().mockResolvedValue({ data: draft, error: null })
  return c
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('provisionVerifiedSignupDraft', () => {
  it('returns not_required without a claimable draft', async () => {
    mockFrom.mockReturnValue(draftQuery(null))
    expect(await provisionVerifiedSignupDraft('u1')).toEqual({ state: 'not_required' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('requires BankID before provisioning', async () => {
    mockFrom.mockReturnValue(draftQuery({ org_number: '5560125790', legal_form: 'aktiebolag', status: 'ready_for_first_login' }))
    mockVerifyFounder.mockResolvedValue({ kind: 'bankid_required' })
    expect(await provisionVerifiedSignupDraft('u1')).toEqual({ state: 'bankid_required' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('passes the verification to the v5 RPC', async () => {
    mockFrom.mockReturnValue(draftQuery({ org_number: '8001011231', legal_form: 'enskild_firma', status: 'ready_for_first_login' }))
    mockVerifyFounder.mockResolvedValue({ kind: 'decided', status: 'verified', reason: 'ef_personnummer_match', evidence: {} })
    mockRpc.mockResolvedValue({
      data: [{ provision_state: 'provisioned', company_id: 'c1', agency_id: null, workspace_type: 'company', onboarding_path: '/onboarding/workspace', provision_reference: 'NK-1' }],
      error: null,
    })

    const result = await provisionVerifiedSignupDraft('u1')

    expect(mockVerifyFounder).toHaveBeenCalledWith(expect.anything(), { userId: 'u1', entityType: 'enskild_firma', orgNumber: '8001011231' })
    expect(mockRpc).toHaveBeenCalledWith('provision_authorized_signup_draft_v5', {
      p_user_id: 'u1',
      p_verification_status: 'verified',
      p_verification_reason: 'ef_personnummer_match',
      p_verification_evidence: {},
    })
    expect(result).toMatchObject({ state: 'provisioned', workspace: { companyId: 'c1' } })
  })

  it('does not re-verify an already provisioned draft', async () => {
    mockFrom.mockReturnValue(draftQuery({ org_number: null, legal_form: 'aktiebolag', status: 'provisioned' }))
    mockRpc.mockResolvedValue({ data: [], error: null })
    await provisionVerifiedSignupDraft('u1')
    expect(mockVerifyFounder).not.toHaveBeenCalled()
  })
})
