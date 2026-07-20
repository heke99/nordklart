import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

// Local seed with a PAST fiscal period (2025) — the close requires the
// period to have ended.
async function seedCompany(overrides: { isClosed?: boolean } = {}): Promise<{
  userId: string
  companyId: string
  fiscalPeriodId: string
}> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    isClosed: overrides.isClosed,
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    name: '2025',
  })
  return { userId, companyId, fiscalPeriodId }
}

// Atomic year-end closing (revision items B01, B02, B03, B05, B08, B09).
//
// Covers:
//   - execute_year_end_closing posts closing entry + IB, locks + closes the
//     period, creates/reuses the next period and verifies continuity — all in
//     ONE transaction.
//   - Idempotency: the same idempotency key replays the completed run; a
//     different key errors with YE_ALREADY_CLOSED.
//   - Concurrency: two parallel calls yield exactly ONE closing entry + ONE
//     opening balance (advisory lock).
//   - Fail-closed readiness inside the transaction (draft entry blocks).
//   - Atomicity: a failing close leaves the period completely untouched.
//   - Unique partial indexes block a second posted year_end / opening_balance
//     per period even when the RPC is bypassed.
//   - post_currency_revaluation: snapshot-key idempotency + controlled replace.

async function postSimpleActivity(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  amount?: number
}): Promise<void> {
  const pool = getPool()
  const entryId = randomUUID()
  const amount = params.amount ?? 1000
  await pool.query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', '2025-06-01', 'Sale', 'manual', 'draft')`,
    [entryId, params.userId, params.companyId, params.fiscalPeriodId],
  )
  await pool.query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', $2, 0), ($1, '3001', 0, $2)`,
    [entryId, amount],
  )
  await pool.query(
    `SELECT * FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
    [params.companyId, entryId],
  )
}

async function closePeriodViaRpc(
  companyId: string,
  fiscalPeriodId: string,
  userId: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query(
    `SELECT public.execute_year_end_closing($1::uuid, $2::uuid, $3::uuid, $4, NULL) AS result`,
    [companyId, fiscalPeriodId, userId, idempotencyKey],
  )
  return rows[0].result as Record<string, unknown>
}

describe('execute_year_end_closing (atomic close)', () => {
  it('closes the period atomically: closing entry, lock, close, next period, IB, continuity', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await postSimpleActivity({ userId, companyId, fiscalPeriodId })

    const result = await closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'k1')
    expect(result.idempotent).toBe(false)
    expect(result.closing_entry_id).toBeTruthy()
    expect(result.opening_balance_entry_id).toBeTruthy()
    expect(result.next_period_id).toBeTruthy()

    const pool = getPool()
    const { rows: periodRows } = await pool.query(
      `SELECT is_closed, locked_at, closing_entry_id FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(periodRows[0].is_closed).toBe(true)
    expect(periodRows[0].locked_at).not.toBeNull()
    expect(periodRows[0].closing_entry_id).toBe(result.closing_entry_id)

    const { rows: nextRows } = await pool.query(
      `SELECT opening_balance_entry_id, opening_balances_set, continuity_verified
       FROM public.fiscal_periods WHERE id = $1`,
      [result.next_period_id],
    )
    expect(nextRows[0].opening_balance_entry_id).toBe(result.opening_balance_entry_id)
    expect(nextRows[0].opening_balances_set).toBe(true)
    expect(nextRows[0].continuity_verified).toBe(true)

    // Class 3-8 must net to zero after closing.
    const { rows: netRows } = await pool.query(
      `SELECT COALESCE(round(sum(l.debit_amount - l.credit_amount), 2), 0) AS net
       FROM public.journal_entry_lines l
       JOIN public.journal_entries e ON e.id = l.journal_entry_id
       WHERE e.fiscal_period_id = $1 AND e.status IN ('posted','reversed')
         AND substring(l.account_number, 1, 1) IN ('3','4','5','6','7','8')`,
      [fiscalPeriodId],
    )
    expect(Number(netRows[0].net)).toBe(0)

    // The run is recorded as closed.
    const { rows: runRows } = await pool.query(
      `SELECT status, idempotency_key FROM public.year_end_runs
       WHERE fiscal_period_id = $1 AND status = 'closed'`,
      [fiscalPeriodId],
    )
    expect(runRows).toHaveLength(1)
    expect(runRows[0].idempotency_key).toBe('k1')
  })

  it('replays idempotently on the same key and rejects a different key (B09)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await postSimpleActivity({ userId, companyId, fiscalPeriodId })

    const first = await closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'retry-key')
    const replay = await closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'retry-key')
    expect(replay.idempotent).toBe(true)
    expect(replay.closing_entry_id).toBe(first.closing_entry_id)

    await expect(
      closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'different-key'),
    ).rejects.toThrow(/YE_ALREADY_CLOSED/)

    // Still exactly one closing entry + one IB.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.journal_entries
       WHERE company_id = $1 AND source_type = 'year_end' AND status = 'posted'`,
      [companyId],
    )
    expect(rows[0].n).toBe(1)
  })

  it('two concurrent closes yield exactly one closing entry and one IB (B09)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await postSimpleActivity({ userId, companyId, fiscalPeriodId })

    const results = await Promise.allSettled([
      closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'conc-key'),
      closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'conc-key'),
    ])
    // Both should resolve (second is an idempotent replay after the advisory
    // lock releases) — or the second may fail with ALREADY_CLOSED if it used
    // a different key. With the same key both succeed.
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled.length).toBe(2)

    const pool = getPool()
    const { rows: closing } = await pool.query(
      `SELECT count(*)::int AS n FROM public.journal_entries
       WHERE company_id = $1 AND source_type = 'year_end' AND status = 'posted'`,
      [companyId],
    )
    expect(closing[0].n).toBe(1)
    const { rows: obs } = await pool.query(
      `SELECT count(*)::int AS n FROM public.journal_entries
       WHERE company_id = $1 AND source_type = 'opening_balance' AND status = 'posted'`,
      [companyId],
    )
    expect(obs[0].n).toBe(1)
  })

  it('readiness runs INSIDE the transaction and fails closed on drafts (B03/B04)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await postSimpleActivity({ userId, companyId, fiscalPeriodId })

    // Leave a draft in the period.
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 0, 'A', '2025-06-02', 'Draft', 'manual', 'draft')`,
      [randomUUID(), userId, companyId, fiscalPeriodId],
    )

    await expect(
      closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'draft-key'),
    ).rejects.toThrow(/YE_NOT_READY/)

    // Nothing persisted: period fully open, no closing entry, no run row.
    const pool = getPool()
    const { rows: periodRows } = await pool.query(
      `SELECT is_closed, locked_at, closing_entry_id FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(periodRows[0].is_closed).toBe(false)
    expect(periodRows[0].locked_at).toBeNull()
    expect(periodRows[0].closing_entry_id).toBeNull()
    const { rows: entries } = await pool.query(
      `SELECT count(*)::int AS n FROM public.journal_entries
       WHERE company_id = $1 AND source_type IN ('year_end','opening_balance')`,
      [companyId],
    )
    expect(entries[0].n).toBe(0)
  })

  it('a failing close leaves the books completely untouched (B02)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await postSimpleActivity({ userId, companyId, fiscalPeriodId })

    // Pre-create the next period WITH an opening balance from another source
    // so the close fails midway (after posting the closing entry).
    const nextPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      name: '2026-next',
    })
    const obEntry = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 0, 'A', '2026-01-01', 'IB other', 'opening_balance', 'draft')`,
      [obEntry, userId, companyId, nextPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 500, 0), ($1, '2099', 0, 500)`,
      [obEntry],
    )
    await getPool().query(`SELECT * FROM public.commit_journal_entry($1::uuid, $2::uuid)`, [
      companyId,
      obEntry,
    ])
    await getPool().query(
      `UPDATE public.fiscal_periods SET opening_balance_entry_id = $1, opening_balances_set = true WHERE id = $2`,
      [obEntry, nextPeriodId],
    )

    await expect(
      closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'fail-key'),
    ).rejects.toThrow(/YE_NOT_READY|YE_NEXT_PERIOD_HAS_OB/)

    // Fully open — the closing entry that may have been created inside the
    // transaction was rolled back with it.
    const pool = getPool()
    const { rows: periodRows } = await pool.query(
      `SELECT is_closed, locked_at, closing_entry_id FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(periodRows[0].is_closed).toBe(false)
    expect(periodRows[0].locked_at).toBeNull()
    expect(periodRows[0].closing_entry_id).toBeNull()
    const { rows: yeEntries } = await pool.query(
      `SELECT count(*)::int AS n FROM public.journal_entries
       WHERE company_id = $1 AND source_type = 'year_end'`,
      [companyId],
    )
    expect(yeEntries[0].n).toBe(0)
  })

  it('DB unique index blocks a second posted year_end entry per period even when the RPC is bypassed', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // Insert one posted year_end entry directly into the OPEN period (with
    // balanced lines in the same transaction so the deferred balance guard
    // passes), then attempt a second — the partial unique index must reject.
    const client = await getPool().connect()
    try {
      const insertPostedYearEnd = async (voucherNumber: number) => {
        const id = randomUUID()
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO public.journal_entries
             (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
              entry_date, description, source_type, status, committed_at)
           VALUES ($1, $2, $3, $4, $5, 'A', '2025-12-31', 'Close', 'year_end', 'posted', now())`,
          [id, userId, companyId, fiscalPeriodId, voucherNumber],
        )
        await client.query(
          `INSERT INTO public.journal_entry_lines
             (journal_entry_id, account_number, debit_amount, credit_amount)
           VALUES ($1, '3001', 100, 0), ($1, '2099', 0, 100)`,
          [id],
        )
        await client.query('COMMIT')
      }

      await insertPostedYearEnd(9001)
      await expect(insertPostedYearEnd(9002)).rejects.toThrow(
        /journal_entries_one_year_end_per_period|duplicate key/,
      )
      await client.query('ROLLBACK').catch(() => {})
    } finally {
      client.release()
    }
  })
})

describe('post_currency_revaluation (idempotent FX snapshot, B05)', () => {
  const LINES = JSON.stringify([
    { account_number: '1510', debit_amount: 100, credit_amount: 0, line_description: 'FX' },
    { account_number: '3960', debit_amount: 0, credit_amount: 100, line_description: 'FX gain' },
  ])

  async function callReval(
    companyId: string,
    periodId: string,
    userId: string,
    snapshotKey: string,
    lines: string = LINES,
  ): Promise<Record<string, unknown>> {
    const { rows } = await getPool().query(
      `SELECT public.post_currency_revaluation($1::uuid, $2::uuid, $3::uuid, '2025-12-31'::date, $4, $5::jsonb, '[]'::jsonb) AS result`,
      [companyId, periodId, userId, snapshotKey, lines],
    )
    return rows[0].result as Record<string, unknown>
  }

  it('same snapshot key reuses the posted run; different key replaces it with reversal', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const first = await callReval(companyId, fiscalPeriodId, userId, 'snap-1')
    expect(first.reused).toBe(false)
    expect(first.entry_id).toBeTruthy()

    const replay = await callReval(companyId, fiscalPeriodId, userId, 'snap-1')
    expect(replay.reused).toBe(true)
    expect(replay.entry_id).toBe(first.entry_id)

    // Changed underlag → controlled replace: old entry reversed, new posted.
    const second = await callReval(companyId, fiscalPeriodId, userId, 'snap-2')
    expect(second.reused).toBe(false)
    expect(second.entry_id).not.toBe(first.entry_id)

    const pool = getPool()
    const { rows: oldEntry } = await pool.query(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [first.entry_id],
    )
    expect(oldEntry[0].status).toBe('reversed')

    const { rows: runs } = await pool.query(
      `SELECT status FROM public.currency_revaluation_runs
       WHERE fiscal_period_id = $1 ORDER BY created_at`,
      [fiscalPeriodId],
    )
    expect(runs.map((r) => r.status)).toEqual(['replaced', 'posted'])
  })

  it('refuses to revalue a closed/locked period', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany({ isClosed: true })
    await expect(callReval(companyId, fiscalPeriodId, userId, 'snap-x')).rejects.toThrow(
      /FX_PERIOD_CLOSED/,
    )
  })
})

describe('FX revaluation through the atomic close (B01 + B08)', () => {
  it('posts the revaluation with the close and creates the deterministic reversal in the next period', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await postSimpleActivity({ userId, companyId, fiscalPeriodId })

    const revaluation = {
      balance_date: '2025-12-31',
      snapshot_key: 'close-snap-1',
      lines: [
        { account_number: '1510', debit_amount: 250, credit_amount: 0, line_description: 'FX' },
        { account_number: '3960', debit_amount: 0, credit_amount: 250, line_description: 'FX gain' },
      ],
      items: [],
    }

    const { rows } = await getPool().query(
      `SELECT public.execute_year_end_closing($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb) AS result`,
      [companyId, fiscalPeriodId, userId, 'fx-close-key', JSON.stringify(revaluation)],
    )
    const result = rows[0].result as Record<string, unknown>
    expect(result.revaluation_entry_id).toBeTruthy()
    expect(result.revaluation_reversal_entry_id).toBeTruthy()

    const pool = getPool()
    // The reversal lives in the NEXT period with mirrored lines and its own
    // source type (never colliding with the next period's own revaluation).
    const { rows: reversal } = await pool.query(
      `SELECT e.fiscal_period_id, e.source_type, l.account_number, l.debit_amount, l.credit_amount
       FROM public.journal_entries e
       JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
       WHERE e.id = $1 ORDER BY l.account_number`,
      [result.revaluation_reversal_entry_id],
    )
    expect(reversal).toHaveLength(2)
    expect(reversal[0].fiscal_period_id).toBe(result.next_period_id)
    expect(reversal[0].source_type).toBe('currency_revaluation_reversal')
    // Mirrored: 1510 credited by 250, 3960 debited by 250.
    expect(Number(reversal[0].credit_amount)).toBe(250)
    expect(Number(reversal[1].debit_amount)).toBe(250)

    // 1510 net across BOTH periods = IB(+250 via OB) - 250 reversal + IB base
    // — i.e. the revaluation leaves no residue in the new year beyond the
    // opening balance itself: revaluation(+250 in N) rolls into IB, the
    // reversal (-250 in N+1) removes it. Verify the 1510 movement in N+1
    // excluding the OB entry is exactly -250.
    const { rows: nextMovement } = await pool.query(
      `SELECT COALESCE(round(sum(l.debit_amount - l.credit_amount), 2), 0) AS net
       FROM public.journal_entry_lines l
       JOIN public.journal_entries e ON e.id = l.journal_entry_id
       WHERE e.fiscal_period_id = $1
         AND e.source_type <> 'opening_balance'
         AND l.account_number = '1510'`,
      [result.next_period_id],
    )
    expect(Number(nextMovement[0].net)).toBe(-250)

    // The run row links revaluation + reversal.
    const { rows: run } = await pool.query(
      `SELECT entry_id, reversal_entry_id, status FROM public.currency_revaluation_runs
       WHERE company_id = $1 AND fiscal_period_id = $2`,
      [companyId, fiscalPeriodId],
    )
    expect(run[0].status).toBe('posted')
    expect(run[0].entry_id).toBe(result.revaluation_entry_id)
    expect(run[0].reversal_entry_id).toBe(result.revaluation_reversal_entry_id)
  })
})
