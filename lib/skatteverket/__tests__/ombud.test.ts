import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ rpc, from }),
}))

import { recordSkvOmbudObservation, verdictFromResponse } from '../ombud'

function companyLookup(orgNumber: string | null, error: unknown = null) {
  from.mockReturnValue({
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({
          data: orgNumber ? { org_number: orgNumber } : null,
          error,
        }),
      }),
    }),
  })
}

describe('verdictFromResponse', () => {
  it('reads a success as authorised', () => {
    expect(verdictFromResponse(200, null)).toBe(true)
    expect(verdictFromResponse(204, '')).toBe(true)
  })

  it('reads a behörighet refusal as denied', () => {
    expect(verdictFromResponse(403, 'Behörighet saknas för detta företag')).toBe(false)
    expect(verdictFromResponse(403, 'behorighet saknas')).toBe(false)
  })

  it('refuses to turn anything else into a verdict', () => {
    // These are the cases that matter: a row written from any of them would
    // claim to know something about authorisation that the response never said.
    expect(verdictFromResponse(500, 'internal error')).toBeNull()
    expect(verdictFromResponse(429, 'slow down')).toBeNull()
    expect(verdictFromResponse(401, 'token expired')).toBeNull()
    expect(verdictFromResponse(403, 'invalid_scope')).toBeNull()
    expect(verdictFromResponse(0, null)).toBeNull()
  })
})

describe('recordSkvOmbudObservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rpc.mockResolvedValue({ error: null })
  })

  it('resolves the org number from the company and hands the RPC an observation', async () => {
    companyLookup('5566778899')

    await recordSkvOmbudObservation({
      companyId: 'company-1',
      authFlow: 'per_bankid',
      authorized: true,
      correlationId: 'corr-1',
      statusCode: 200,
      operation: 'agi/kvittenser',
    })

    expect(rpc).toHaveBeenCalledWith('record_skv_ombud_observation', {
      p_company_id: 'company-1',
      p_org_number: '5566778899',
      p_auth_flow: 'per_bankid',
      p_observation: {
        kind: 'skv_response',
        authorized: true,
        correlation_id: 'corr-1',
        status_code: 200,
        skv_error_code: null,
        operation: 'agi/kvittenser',
      },
    })
  })

  it('never sends a status the caller could dictate — kind is always skv_response', async () => {
    companyLookup('5566778899')
    await recordSkvOmbudObservation({
      companyId: 'company-1', authFlow: 'ccg_sysorg', authorized: false, statusCode: 403,
    })
    const [, args] = rpc.mock.calls[0]
    expect((args as { p_observation: { kind: string } }).p_observation.kind).toBe('skv_response')
  })

  it('skips silently when the company has no org number', async () => {
    companyLookup(null)
    await recordSkvOmbudObservation({
      companyId: 'company-1', authFlow: 'per_bankid', authorized: true,
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('does nothing without a company', async () => {
    await recordSkvOmbudObservation({
      companyId: '', authFlow: 'per_bankid', authorized: true,
    })
    expect(from).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('swallows an RPC failure — a filing must not fail on its bookkeeping', async () => {
    companyLookup('5566778899')
    rpc.mockResolvedValue({ error: { message: 'boom', code: '42501' } })

    await expect(
      recordSkvOmbudObservation({
        companyId: 'company-1', authFlow: 'per_bankid', authorized: true,
      }),
    ).resolves.toBeUndefined()
  })

  it('swallows a thrown client error too', async () => {
    from.mockImplementation(() => { throw new Error('no env') })
    await expect(
      recordSkvOmbudObservation({
        companyId: 'company-1', authFlow: 'per_bankid', authorized: true,
      }),
    ).resolves.toBeUndefined()
  })
})
