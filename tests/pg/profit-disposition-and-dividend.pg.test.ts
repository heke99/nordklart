import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember, insertCompanySettings, insertFiscalPeriod } from '@/tests/pg/fixtures'
import { getPool, withServiceRole, withUserContext } from '@/tests/pg/setup'

/** Covers 20260925130000_profit_disposition_and_dividend_booking. */

type Line = [account: string, debit: number, credit: number]

async function insertEntry(p: {
  userId: string
  companyId: string
  periodId: string
  date: string
  source: string
  lines: Line[]
  status?: 'posted' | 'draft'
}): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, $5, 'A', $6, 'test', $7, $8)`,
      [id, p.userId, p.companyId, p.periodId, p.status === 'draft' ? 0 : Math.floor(Math.random() * 1e8) + 1, p.date, p.source, p.status ?? 'posted'],
    )
    for (const [account, debit, credit] of p.lines) {
      await client.query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
        [id, account, debit, credit],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return id
}

async function setup(entityType: 'aktiebolag' | 'enskild_firma' = 'aktiebolag') {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId, entityType, orgNumber: entityType === 'aktiebolag' ? '5560000001' : null })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertCompanySettings({ companyId })
  const p2025 = await insertFiscalPeriod({ userId, companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31' })
  const p2026 = await insertFiscalPeriod({ userId, companyId, name: '2026', periodStart: '2026-01-01', periodEnd: '2026-12-31' })
  const e = (periodId: string, date: string, source: string, lines: Line[], status?: 'posted' | 'draft') =>
    insertEntry({ userId, companyId, periodId, date, source, lines, status })

  // 2025: IB balanserad vinst 50 000, aktieägartillskott 10 000, resultat 80 000.
  const ob = await e(p2025, '2025-01-01', 'opening_balance', [['1930', 50000, 0], ['2091', 0, 50000]])
  await getPool().query(`UPDATE public.fiscal_periods SET opening_balance_entry_id = $1 WHERE id = $2`, [ob, p2025])
  await e(p2025, '2025-03-01', 'manual', [['1930', 100000, 0], ['3001', 0, 100000]])
  await e(p2025, '2025-04-01', 'manual', [['5010', 20000, 0], ['1930', 0, 20000]])
  await e(p2025, '2025-06-01', 'manual', [['1930', 10000, 0], ['2093', 0, 10000]])
  // Imported closing: the result moved to 2099 through 8999.
  await e(p2025, '2025-12-31', 'import', [['8999', 80000, 0], ['2099', 0, 80000]])
  return { userId, companyId, p2025, p2026, e }
}

const proposal = async (companyId: string, periodId: string) =>
  (await getPool().query(`SELECT public.year_end_profit_disposition_proposal($1, $2) AS p`, [companyId, periodId])).rows[0].p

const recordDisposition = (s: { companyId: string; p2025: string; userId: string }, payload: Record<string, unknown>) =>
  withServiceRole(async (c) =>
    (await c.query(`SELECT public.record_year_end_profit_disposition($1, $2, $3, $4::jsonb) AS r`, [s.companyId, s.p2025, s.userId, JSON.stringify(payload)])).rows[0].r,
  )

const dividendPayload = {
  // Deliberately wrong: the RPC must take these from the ledger.
  current_year_result: 1,
  free_equity: 999999,
  carried_forward: 999999,
  proposed_dividend: 40000,
  amount_per_share: 40,
  share_count: 1000,
  planned_payment_date: '2026-06-01',
  board_reasoning: 'Bolaget har god likviditet.',
  prudence_assessment: 'Utdelningen är försvarlig enligt ABL 17:3.',
}

async function bookDecision(s: Awaited<ReturnType<typeof setup>>, proposalId: string, amount: number, draftId: string, reason: string | null = null) {
  return withServiceRole(async (c) =>
    (await c.query(
      `SELECT public.book_dividend_decision($1, $2, '2026-05-15', $3, NULL, $4, $5, $6) AS r`,
      [s.companyId, proposalId, amount, reason, draftId, s.userId],
    )).rows[0].r,
  )
}

describe('year_end_profit_disposition_proposal', () => {
  it('takes the year result without the closing voucher and all free equity 2090–2099', async () => {
    const s = await setup()
    const p = await proposal(s.companyId, s.p2025)
    expect(p.applicable).toBe(true)
    expect(Number(p.current_year_result)).toBe(80000)
    expect(Number(p.retained_earnings)).toBe(60000)
    expect(Number(p.free_equity)).toBe(140000)
    expect(p.proposal_text).toContain('Till årsstämmans förfogande')
  })

  it('does not count earlier years in the year result', async () => {
    const s = await setup()
    const p2024 = await insertFiscalPeriod({ userId: s.userId, companyId: s.companyId, name: '2024', periodStart: '2024-01-01', periodEnd: '2024-12-31' })
    await s.e(p2024, '2024-05-01', 'manual', [['1930', 5000, 0], ['3001', 0, 5000]])
    const p = await proposal(s.companyId, s.p2025)
    expect(Number(p.current_year_result)).toBe(80000)
  })

  it('reports a loss as a negative amount at the stämma\'s disposal', async () => {
    const s = await setup()
    await s.e(s.p2025, '2025-09-01', 'manual', [['5010', 200000, 0], ['1930', 0, 200000]])
    const p = await proposal(s.companyId, s.p2025)
    expect(Number(p.current_year_result)).toBe(-120000)
    expect(Number(p.free_equity)).toBe(-60000)
    expect(Number(p.available_for_distribution)).toBe(0)
  })

  it('is not applicable to an enskild firma', async () => {
    const s = await setup('enskild_firma')
    const p = await proposal(s.companyId, s.p2025)
    expect(p.applicable).toBe(false)
  })
})

describe('record_year_end_profit_disposition', () => {
  it('stores ledger amounts, not the payload', async () => {
    const s = await setup()
    const r = await recordDisposition(s, dividendPayload)
    expect(Number(r.free_equity)).toBe(140000)
    expect(Number(r.current_year_result)).toBe(80000)
    expect(Number(r.carried_forward)).toBe(100000)
  })

  it('refuses a dividend above fritt eget kapital (ABL 17:3)', async () => {
    const s = await setup()
    await expect(recordDisposition(s, { ...dividendPayload, proposed_dividend: 150000, amount_per_share: 150 }))
      .rejects.toMatchObject({ message: 'YEAR_END_DIVIDEND_EXCEEDS_FREE_EQUITY' })
  })

  it('records a loss carried forward', async () => {
    const s = await setup()
    await s.e(s.p2025, '2025-09-01', 'manual', [['5010', 200000, 0], ['1930', 0, 200000]])
    const r = await recordDisposition(s, { proposed_dividend: 0 })
    expect(Number(r.carried_forward)).toBe(-60000)
  })

  it('records on a closed year (after tax is booked) but not once the stämma adopted the accounts', async () => {
    const s = await setup()
    await getPool().query(`UPDATE public.fiscal_periods SET is_closed = true, closed_at = now(), locked_at = now() WHERE id = $1`, [s.p2025])
    const r = await recordDisposition(s, { proposed_dividend: 0 })
    expect(Number(r.free_equity)).toBe(140000)
    await getPool().query(
      `INSERT INTO public.arsredovisning_narratives (company_id, fiscal_period_id, agm_date, agm_accounts_adopted) VALUES ($1, $2, '2026-05-15', true)`,
      [s.companyId, s.p2025],
    )
    await expect(recordDisposition(s, { proposed_dividend: 0 })).rejects.toMatchObject({ message: 'YEAR_END_PROFIT_DISPOSITION_LOCKED' })
  })

  it('refuses a payment date on or before the balance date', async () => {
    const s = await setup()
    await expect(recordDisposition(s, { ...dividendPayload, planned_payment_date: '2025-12-31' }))
      .rejects.toMatchObject({ message: 'YEAR_END_DIVIDEND_PAYMENT_DATE_INVALID' })
  })
})

describe('book_dividend_decision / book_dividend_payment', () => {
  async function decided() {
    const s = await setup()
    await recordDisposition(s, dividendPayload)
    const { rows } = await getPool().query(`SELECT id FROM public.dividend_proposals WHERE company_id = $1`, [s.companyId])
    return { s, proposalId: rows[0].id as string }
  }
  const adopt = (s: Awaited<ReturnType<typeof setup>>) =>
    getPool().query(
      `INSERT INTO public.arsredovisning_narratives (company_id, fiscal_period_id, agm_date, agm_accounts_adopted) VALUES ($1, $2, '2026-05-15', true)`,
      [s.companyId, s.p2025],
    )
  const transfer = (s: Awaited<ReturnType<typeof setup>>) =>
    s.e(s.p2026, '2026-01-01', 'result_appropriation', [['2099', 80000, 0], ['2098', 0, 80000]])
  const decisionDraft = (s: Awaited<ReturnType<typeof setup>>, lines: Line[]) =>
    s.e(s.p2026, '2026-05-15', 'dividend_decision', lines, 'draft')
  const goodLines: Line[] = [['2098', 80000, 0], ['2898', 0, 40000], ['2091', 0, 40000]]

  it('requires the annual report to be adopted', async () => {
    const { s, proposalId } = await decided()
    await transfer(s)
    await expect(bookDecision(s, proposalId, 40000, await decisionDraft(s, goodLines)))
      .rejects.toMatchObject({ message: 'DIVIDEND_ANNUAL_REPORT_NOT_ADOPTED' })
  })

  it('requires last year\'s result moved off 2099', async () => {
    const { s, proposalId } = await decided()
    await adopt(s)
    await expect(bookDecision(s, proposalId, 40000, await decisionDraft(s, goodLines)))
      .rejects.toMatchObject({ message: 'DIVIDEND_PRIOR_RESULT_NOT_TRANSFERRED' })
  })

  it('refuses more than the board proposed (ABL 18:1) and more than is distributable', async () => {
    const { s, proposalId } = await decided()
    await adopt(s)
    await transfer(s)
    const lines50: Line[] = [['2098', 80000, 0], ['2898', 0, 50000], ['2091', 0, 30000]]
    await expect(bookDecision(s, proposalId, 50000, await decisionDraft(s, lines50)))
      .rejects.toMatchObject({ message: 'DIVIDEND_EXCEEDS_BOARD_PROPOSAL' })
    const lines150: Line[] = [['2098', 80000, 0], ['2091', 70000, 0], ['2898', 0, 150000]]
    await expect(bookDecision(s, proposalId, 150000, await decisionDraft(s, lines150), 'Minoritetskrav enligt ABL 18:11'))
      .rejects.toMatchObject({ message: 'DIVIDEND_EXCEEDS_DISTRIBUTABLE' })
  })

  it('reduces the distributable amount by a fondemission after the balance date', async () => {
    const { s, proposalId } = await decided()
    await adopt(s)
    await transfer(s)
    await s.e(s.p2026, '2026-03-01', 'manual', [['2091', 110000, 0], ['2081', 0, 110000]])
    const limits = await withServiceRole(async (c) =>
      (await c.query(`SELECT public.dividend_distributable_amount($1, $2, '2026-05-15') AS l`, [s.companyId, proposalId])).rows[0].l,
    )
    expect(Number(limits.moved_to_restricted_equity)).toBe(110000)
    expect(Number(limits.distributable)).toBe(30000)
  })

  it('refuses a voucher that does not clear 2098 into 2091', async () => {
    const { s, proposalId } = await decided()
    await adopt(s)
    await transfer(s)
    await expect(bookDecision(s, proposalId, 40000, await decisionDraft(s, [['2091', 40000, 0], ['2898', 0, 40000]])))
      .rejects.toMatchObject({ message: 'DIVIDEND_DRAFT_INVALID' })
  })

  it('books the decision atomically, then payments up to the decided amount', async () => {
    const { s, proposalId } = await decided()
    await adopt(s)
    await transfer(s)
    const draft = await decisionDraft(s, goodLines)
    const res = await bookDecision(s, proposalId, 40000, draft)
    expect(res.journal_entry_id).toBe(draft)

    const { rows: je } = await getPool().query(`SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`, [draft])
    expect(je[0].status).toBe('posted')
    expect(je[0].voucher_number).toBeGreaterThan(0)
    const { rows: ev } = await getPool().query(
      `SELECT fiscal_period_id, amount FROM public.year_end_equity_events WHERE journal_entry_id = $1 AND event_type = 'dividend_decision'`,
      [draft],
    )
    expect(ev).toHaveLength(1)
    expect(ev[0].fiscal_period_id).toBe(s.p2026)
    const { rows: disp } = await getPool().query(`SELECT status, locked_at FROM public.year_end_profit_dispositions WHERE company_id = $1`, [s.companyId])
    expect(disp[0].status).toBe('locked')

    await expect(bookDecision(s, proposalId, 40000, await decisionDraft(s, goodLines)))
      .rejects.toMatchObject({ message: 'DIVIDEND_ALREADY_DECIDED' })

    const pay = async (lines: Line[]) => {
      const d = await s.e(s.p2026, '2026-06-01', 'dividend_payment', lines, 'draft')
      return withServiceRole(async (c) =>
        (await c.query(`SELECT public.book_dividend_payment($1, $2, $3, $4) AS r`, [s.companyId, res.dividend_decision_id, d, s.userId])).rows[0].r,
      )
    }
    const first = await pay([['2898', 25000, 0], ['1930', 0, 25000]])
    expect(Number(first.remaining)).toBe(15000)
    await expect(pay([['2898', 20000, 0], ['1930', 0, 20000]])).rejects.toMatchObject({ message: 'DIVIDEND_OVERPAID' })
    await expect(pay([['2898', 5000, 0], ['3001', 0, 5000]])).rejects.toMatchObject({ message: 'DIVIDEND_DRAFT_INVALID' })
    const last = await pay([['2898', 15000, 0], ['1930', 0, 15000]])
    expect(Number(last.remaining)).toBe(0)
  })

  it('is not callable by an authenticated user', async () => {
    const { s, proposalId } = await decided()
    await withUserContext(s.userId, async (c) => {
      await expect(c.query(
        `SELECT public.book_dividend_decision($1, $2, '2026-05-15', 1, NULL, NULL, $3, $4)`,
        [s.companyId, proposalId, randomUUID(), s.userId],
      )).rejects.toMatchObject({ code: '42501' })
    })
  })
})

describe('journal_entries source types', () => {
  it('accepts the dividend and inventory voucher types', async () => {
    const s = await setup()
    for (const source of ['dividend_decision', 'dividend_payment', 'year_end_inventory']) {
      await expect(s.e(s.p2026, '2026-06-30', source, [['1460', 100, 0], ['4960', 0, 100]])).resolves.toBeTypeOf('string')
    }
  })
})
