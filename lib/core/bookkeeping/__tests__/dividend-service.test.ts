import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createDraftEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/core/bookkeeping/result-appropriation-service', () => ({
  generateResultAppropriation: vi.fn(),
}))

import { createDraftEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { generateResultAppropriation } from '@/lib/core/bookkeeping/result-appropriation-service'
import { eventBus } from '@/lib/events'
import {
  assessDividendPrudence,
  bookDividendDecision,
  bookDividendPayment,
  DividendError,
  ku31Obligation,
  planDividendDecisionLines,
} from '../dividend-service'

function sums(lines: ReturnType<typeof planDividendDecisionLines>) {
  const by = (acct: string) =>
    lines.filter((l) => l.account_number === acct).reduce((s, l) => s + l.credit_amount - l.debit_amount, 0)
  const debit = lines.reduce((s, l) => s + l.debit_amount, 0)
  const credit = lines.reduce((s, l) => s + l.credit_amount, 0)
  return { by, debit, credit }
}

describe('planDividendDecisionLines', () => {
  it('clears 2098, credits 2898 and balances the rest to 2091', () => {
    const s = sums(planDividendDecisionLines(80_000, 40_000))
    expect(s.by('2098')).toBe(-80_000)
    expect(s.by('2898')).toBe(40_000)
    expect(s.by('2091')).toBe(40_000)
    expect(s.debit).toBe(s.credit)
  })

  it('takes a dividend larger than last year\'s result from 2091', () => {
    const s = sums(planDividendDecisionLines(30_000, 50_000))
    expect(s.by('2098')).toBe(-30_000)
    expect(s.by('2091')).toBe(-20_000)
    expect(s.by('2898')).toBe(50_000)
    expect(s.debit).toBe(s.credit)
  })

  it('moves a prior-year loss on 2098 to 2091', () => {
    const s = sums(planDividendDecisionLines(-10_000, 5_000))
    expect(s.by('2098')).toBe(10_000)
    expect(s.by('2091')).toBe(-15_000)
    expect(s.debit).toBe(s.credit)
  })

  it('refuses a zero dividend', () => {
    expect(() => planDividendDecisionLines(10_000, 0)).toThrow(DividendError)
  })
})

describe('assessDividendPrudence', () => {
  it('reports equity ratio before and after with untaxed reserves net of 20,6 % tax', () => {
    const r = assessDividendPrudence({ equity: 400_000, untaxedReserves: 100_000, totalAssets: 1_000_000, cash: 300_000, dividend: 200_000 })
    expect(r.adjustedEquityBefore).toBe(479_400)
    expect(r.adjustedEquityAfter).toBe(279_400)
    expect(r.equityRatioBefore).toBeCloseTo(0.4794, 4)
    expect(r.equityRatioAfter).toBeCloseTo(0.3493, 4)
    expect(r.warnings).toEqual([])
  })

  it('warns when the cash does not cover the dividend', () => {
    const r = assessDividendPrudence({ equity: 400_000, untaxedReserves: 0, totalAssets: 1_000_000, cash: 50_000, dividend: 200_000 })
    expect(r.warnings.join(' ')).toMatch(/Likvida medel/)
  })
})

describe('ku31Obligation', () => {
  it('is due 31 January the year after the dividend became available', () => {
    expect(ku31Obligation('2026-05-15', '2026-06-01')).toEqual({ incomeYear: 2026, dueDate: '2027-01-31' })
    expect(ku31Obligation('2026-12-20', '2027-01-10')).toEqual({ incomeYear: 2027, dueDate: '2028-01-31' })
  })
})

describe('bookDividendDecision', () => {
  const updates: unknown[] = []
  function client(rpcResults: Record<string, { data: unknown; error: unknown }>) {
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'update']) {
      builder[m] = vi.fn((arg?: unknown) => {
        if (m === 'update') updates.push(arg)
        return builder
      })
    }
    builder.single = vi.fn(async () => ({ data: { id: 'draft-1', status: 'posted', lines: [] }, error: null }))
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
    return {
      from: vi.fn(() => builder),
      rpc: vi.fn(async (name: string) => rpcResults[name]),
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    updates.length = 0
    vi.mocked(findFiscalPeriod).mockResolvedValue('p-2026')
    vi.mocked(createDraftEntry).mockResolvedValue({ id: 'draft-1' } as never)
  })

  it('transfers last year\'s result first, builds the voucher from 2098 and commits through the RPC', async () => {
    const c = client({
      __ledger_balance_at: { data: 80_000, error: null },
      book_dividend_decision: { data: { dividend_decision_id: 'dd-1', payment_date: '2026-06-01', limits: { distributable: 140_000 } }, error: null },
    })
    const res = await bookDividendDecision(c as never, {
      companyId: 'c1', userId: 'u1', dividendProposalId: 'dp-1', decisionDate: '2026-05-15', amount: 40_000,
    })
    expect(generateResultAppropriation).toHaveBeenCalledWith(c, 'c1', 'u1', 'p-2026')
    const input = vi.mocked(createDraftEntry).mock.calls[0][3]
    expect(input.source_type).toBe('dividend_decision')
    expect(input.entry_date).toBe('2026-05-15')
    expect(input.lines.map((l) => l.account_number)).toEqual(['2098', '2898', '2091'])
    expect(c.rpc).toHaveBeenCalledWith('book_dividend_decision', expect.objectContaining({ p_draft_entry_id: 'draft-1', p_decided_amount: 40_000 }))
    expect(res.dividendDecisionId).toBe('dd-1')
    expect(res.ku31).toEqual({ incomeYear: 2026, dueDate: '2027-01-31' })
  })

  it('cancels the draft and maps the RPC error', async () => {
    const c = client({
      __ledger_balance_at: { data: 80_000, error: null },
      book_dividend_decision: { data: null, error: { message: 'DIVIDEND_EXCEEDS_DISTRIBUTABLE' } },
    })
    await expect(bookDividendDecision(c as never, {
      companyId: 'c1', userId: 'u1', dividendProposalId: 'dp-1', decisionDate: '2026-05-15', amount: 40_000,
    })).rejects.toMatchObject({ code: 'DIVIDEND_EXCEEDS_DISTRIBUTABLE' })
    expect(updates).toContainEqual({ status: 'cancelled' })
  })

  it('refuses a date without an open fiscal year', async () => {
    vi.mocked(findFiscalPeriod).mockResolvedValue(null)
    await expect(bookDividendDecision(client({}) as never, {
      companyId: 'c1', userId: 'u1', dividendProposalId: 'dp-1', decisionDate: '2026-05-15', amount: 1,
    })).rejects.toMatchObject({ code: 'DIVIDEND_NO_OPEN_PERIOD' })
  })
})

describe('bookDividendPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findFiscalPeriod).mockResolvedValue('p-2026')
    vi.mocked(createDraftEntry).mockResolvedValue({ id: 'draft-2' } as never)
  })

  it('only pays from a 19xx cash account', async () => {
    await expect(bookDividendPayment({} as never, {
      companyId: 'c1', userId: 'u1', dividendDecisionId: 'dd-1', paymentDate: '2026-06-01', amount: 100, cashAccount: '3001',
    })).rejects.toMatchObject({ code: 'DIVIDEND_DRAFT_INVALID' })
    expect(createDraftEntry).not.toHaveBeenCalled()
  })
})

describe('formatProfitDispositionText', () => {
  it('lists the funds at the stämma\'s disposal and the proposed disposition', async () => {
    const { formatProfitDispositionText } = await import('@/lib/bokslut/arsredovisning/build-data')
    const raw = formatProfitDispositionText({
      currentYearResult: 80_000,
      availableFunds: 140_000,
      dividend: 40_000,
      carriedForward: 100_000,
      amountPerShare: 40,
      boardStatement: 'Utdelningen är försvarlig.',
    })
    // sv-SE groups thousands with a (narrow) no-break space.
    const text = raw.replace(/[\u00a0\u202f]/g, ' ')
    expect(text).toContain('balanserat resultat 60 000,00')
    expect(text).toContain('årets resultat 80 000,00, totalt 140 000,00')
    expect(text).toContain('40 000,00 kr (40,00 kr per aktie) delas ut')
    expect(text).toContain('100 000,00 kr balanseras i ny räkning')
    expect(text).toContain('Styrelsens yttrande')
  })
})
