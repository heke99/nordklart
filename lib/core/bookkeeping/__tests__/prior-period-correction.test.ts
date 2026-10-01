import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreate = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreate(...args),
}))

import {
  bookPriorPeriodCorrection,
  priorPeriodCorrectionIssues,
  PriorPeriodCorrectionError,
  type PriorPeriodCorrectionInput,
} from '../prior-period-correction'

describe('priorPeriodCorrectionIssues', () => {
  const k2ab = { framework: 'k2' as const, entityType: 'aktiebolag' as const }
  const k3ab = { framework: 'k3' as const, entityType: 'aktiebolag' as const }

  it('allows a current-year correction on result and balance accounts', () => {
    expect(priorPeriodCorrectionIssues({ ...k2ab, method: 'current_year', accounts: ['5410', '2440'] })).toEqual([])
  })

  it('never allows årets resultat', () => {
    expect(priorPeriodCorrectionIssues({ ...k2ab, method: 'current_year', accounts: ['2099', '1930'] })).toContain('closing_result_account')
    expect(priorPeriodCorrectionIssues({ ...k3ab, method: 'equity_restatement', accounts: ['8999', '2091'] })).toContain('closing_result_account')
  })

  it('keeps retained earnings out of a current-year correction for AB', () => {
    expect(priorPeriodCorrectionIssues({ ...k2ab, method: 'current_year', accounts: ['2091', '2440'] })).toEqual([
      'retained_earnings_requires_equity_restatement',
    ])
  })

  it('lets an enskild firma use its equity accounts in a current-year correction', () => {
    expect(
      priorPeriodCorrectionIssues({ framework: 'k2', entityType: 'enskild_firma', method: 'current_year', accounts: ['2013', '1930'] }),
    ).toEqual([])
  })

  it('allows retroactive restatement only for K3 aktiebolag, on balance accounts against 209x', () => {
    expect(priorPeriodCorrectionIssues({ ...k3ab, method: 'equity_restatement', accounts: ['2091', '2440'] })).toEqual([])
    expect(priorPeriodCorrectionIssues({ ...k2ab, method: 'equity_restatement', accounts: ['2091', '2440'] })).toEqual([
      'equity_restatement_requires_k3_ab',
    ])
    expect(
      priorPeriodCorrectionIssues({ framework: 'k3', entityType: 'enskild_firma', method: 'equity_restatement', accounts: ['2091', '2440'] }),
    ).toContain('equity_restatement_requires_k3_ab')
    expect(priorPeriodCorrectionIssues({ ...k3ab, method: 'equity_restatement', accounts: ['5410', '2091'] })).toEqual([
      'equity_restatement_balance_accounts_only',
    ])
    expect(priorPeriodCorrectionIssues({ ...k3ab, method: 'equity_restatement', accounts: ['1510', '2440'] })).toEqual([
      'equity_restatement_needs_equity_line',
    ])
  })
})

const CLOSED = { id: 'p2025', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true }
const OPEN = { id: 'p2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false, locked_at: null }

function fakeSupabase(rows: { erroneous: unknown; target: unknown; company: unknown }) {
  return {
    from: vi.fn((table: string) => {
      const c: Record<string, unknown> = {}
      let id = ''
      c.select = vi.fn(() => c)
      c.eq = vi.fn((col: string, value: string) => {
        if (col === 'id') id = value
        return c
      })
      c.maybeSingle = vi.fn(async () => ({
        data: table === 'companies' ? rows.company : id === 'p2025' ? rows.erroneous : rows.target,
      }))
      return c
    }),
  }
}

const input: PriorPeriodCorrectionInput = {
  method: 'current_year',
  fiscal_period_id: 'p2026',
  entry_date: '2026-03-15',
  description: 'Ej bokförd leverantörsfaktura',
  reason: 'Fakturan från december hittades i mars vid avstämning av leverantörsreskontran.',
  original_reference: 'A47',
  lines: [
    { account_number: '5410', debit_amount: 1000, credit_amount: 0 },
    { account_number: '2440', debit_amount: 0, credit_amount: 1000 },
  ],
}

const company = { entity_type: 'aktiebolag', accounting_framework: 'k2' }

describe('bookPriorPeriodCorrection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreate.mockResolvedValue({ id: 'je-1' })
  })

  it('books a new verifikation in the open year, linked to the closed year, with the reason in notes', async () => {
    const sb = fakeSupabase({ erroneous: CLOSED, target: OPEN, company })
    await bookPriorPeriodCorrection(sb as never, 'c1', 'u1', 'p2025', input)
    expect(mockCreate).toHaveBeenCalledWith(sb, 'c1', 'u1', expect.objectContaining({
      fiscal_period_id: 'p2026',
      entry_date: '2026-03-15',
      description: 'Rättelse 2025: Ej bokförd leverantörsfaktura',
      source_type: 'prior_period_correction',
      source_id: 'p2025',
      lines: input.lines,
    }))
    const notes = mockCreate.mock.calls[0][3].notes as string
    expect(notes).toContain('räkenskapsår 2025 (2025-01-01 – 2025-12-31), rättat i årets resultat')
    expect(notes).toContain('Orsak: Fakturan från december')
    expect(notes).toContain('Avser: A47')
  })

  it('refuses a year that is not closed', async () => {
    const sb = fakeSupabase({ erroneous: { ...CLOSED, is_closed: false }, target: OPEN, company })
    await expect(bookPriorPeriodCorrection(sb as never, 'c1', 'u1', 'p2025', input)).rejects.toMatchObject({
      code: 'PRIOR_CORRECTION_PERIOD_NOT_CLOSED',
    })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it.each([
    ['a closed target year', { ...OPEN, is_closed: true }, input.entry_date],
    ['a locked target year', { ...OPEN, locked_at: '2026-04-01T00:00:00Z' }, input.entry_date],
    ['a target year before the error', { ...OPEN, period_start: '2025-07-01' }, input.entry_date],
    ['a date outside the target year', OPEN, '2027-01-05'],
  ])('refuses %s', async (_label, target, entryDate) => {
    const sb = fakeSupabase({ erroneous: CLOSED, target, company })
    await expect(
      bookPriorPeriodCorrection(sb as never, 'c1', 'u1', 'p2025', { ...input, entry_date: entryDate }),
    ).rejects.toMatchObject({ code: 'PRIOR_CORRECTION_TARGET_INVALID' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('refuses lines that break the method rules and names the issue', async () => {
    const sb = fakeSupabase({ erroneous: CLOSED, target: OPEN, company })
    const err = await bookPriorPeriodCorrection(sb as never, 'c1', 'u1', 'p2025', {
      ...input,
      method: 'equity_restatement',
      lines: [
        { account_number: '2091', debit_amount: 1000, credit_amount: 0 },
        { account_number: '2440', debit_amount: 0, credit_amount: 1000 },
      ],
    }).catch((e) => e)
    expect(err).toBeInstanceOf(PriorPeriodCorrectionError)
    expect(err.code).toBe('PRIOR_CORRECTION_LINES_INVALID')
    expect(err.issues).toEqual(['equity_restatement_requires_k3_ab'])
  })

  it('throws NOT_FOUND for a period of another company', async () => {
    const sb = fakeSupabase({ erroneous: null, target: OPEN, company })
    await expect(bookPriorPeriodCorrection(sb as never, 'c1', 'u1', 'p2025', input)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
