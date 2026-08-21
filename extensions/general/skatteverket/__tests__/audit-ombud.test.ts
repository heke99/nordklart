import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'

const { recordSkvOmbudObservation } = vi.hoisted(() => ({
  recordSkvOmbudObservation: vi.fn(),
}))

vi.mock('@/lib/skatteverket/ombud', () => ({ recordSkvOmbudObservation }))

import { writeSkatteverketAudit } from '../lib/audit'

function makeCtx() {
  const insert = vi.fn().mockResolvedValue({ error: null })
  const ctx = {
    companyId: 'company-1',
    userId: 'user-1',
    supabase: { from: vi.fn(() => ({ insert })) },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  } as unknown as ExtensionContext
  return { ctx, insert }
}

describe('writeSkatteverketAudit — ombud verdict', () => {
  beforeEach(() => vi.clearAllMocks())

  it('records authorised when the call succeeded', async () => {
    const { ctx } = makeCtx()
    await writeSkatteverketAudit(ctx, {
      endpoint: 'agi/kvittenser',
      outcome: 'ok',
      responseStatus: 200,
      correlationId: 'corr-1',
    })

    expect(recordSkvOmbudObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        authFlow: 'per_bankid',
        authorized: true,
        correlationId: 'corr-1',
      }),
    )
  })

  it('records denied when Skatteverket refused on behörighet', async () => {
    const { ctx } = makeCtx()
    await writeSkatteverketAudit(ctx, {
      endpoint: 'agi/underlag',
      outcome: 'auth_error',
      skvAuthCode: 'BEHORIGHET_SAKNAS',
      errorMessage: 'Du har inte behörighet att agera för detta företag',
    })

    expect(recordSkvOmbudObservation).toHaveBeenCalledWith(
      expect.objectContaining({ authorized: false, skvErrorCode: 'BEHORIGHET_SAKNAS' }),
    )
  })

  it('records nothing for auth failures that are not about behörighet', async () => {
    const { ctx } = makeCtx()
    for (const code of ['SESSION_EXPIRED', 'MISSING_SCOPE', 'RATE_LIMITED', 'TOKEN_REVOKED']) {
      await writeSkatteverketAudit(ctx, {
        endpoint: 'agi/underlag', outcome: 'auth_error', skvAuthCode: code,
      })
    }
    // An expired session says nothing about whether the company may be acted
    // for; writing 'denied' from one would strand a legitimate ombud.
    expect(recordSkvOmbudObservation).not.toHaveBeenCalled()
  })

  it('records nothing for a validation or internal error', async () => {
    const { ctx } = makeCtx()
    await writeSkatteverketAudit(ctx, { endpoint: 'moms', outcome: 'validation_error' })
    await writeSkatteverketAudit(ctx, { endpoint: 'moms', outcome: 'internal_error' })
    await writeSkatteverketAudit(ctx, { endpoint: 'moms', outcome: 'skv_error' })
    expect(recordSkvOmbudObservation).not.toHaveBeenCalled()
  })

  it('does not fail the caller when the ombud record throws', async () => {
    const { ctx, insert } = makeCtx()
    recordSkvOmbudObservation.mockRejectedValueOnce(new Error('boom'))

    // A filing must never fail because its derived authorisation bookkeeping
    // did — and the audit row, which is the regulator-facing one, is written
    // first and survives regardless.
    await expect(
      writeSkatteverketAudit(ctx, { endpoint: 'agi/kvittenser', outcome: 'ok' }),
    ).resolves.toBeUndefined()
    expect(insert).toHaveBeenCalled()
  })
})
