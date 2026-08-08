import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertCompanySettings,
  insertFiscalPeriod,
  satisfyManualCashReconciliation,
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
  // Readiness requires an explicit accounting method; without it every close
  // stops at `company_details_incomplete` before the tested condition is hit.
  await insertCompanySettings({ companyId })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    isClosed: overrides.isClosed,
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    name: '2025',
  })

  // Economic year-end RPCs are deliberately entitlement-gated even for an
  // owner. Seed the exact one-off product/period relation used in production.
  const { rows: products } = await getPool().query(
    `SELECT pr.id
     FROM public.platform_products pr
     JOIN public.platform_price_plans pp ON pp.product_id = pr.id
     WHERE pp.code = 'year_end_one_time'
     LIMIT 1`,
  )
  expect(products).toHaveLength(1)
  await getPool().query(
    `INSERT INTO public.one_time_purchases
       (company_id, product_id, purchase_type, status, fiscal_period_id,
        permanent_access, access_starts_at, paid_at, created_by)
     VALUES ($1, $2, 'year_end', 'active', $3, true, now(), now(), $4)`,
    [companyId, products[0].id, fiscalPeriodId, userId],
  )

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
//   - Unique partial indexes block a second posted year_end_closing / opening_balance
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
  previewId?: string,
): Promise<Record<string, unknown>> {
  // The seeded company has no bank connection, so every cash account needs a
  // manual statement attestation before the books may close. Done here (rather
  // than in the seed) because it must happen after the test has posted its
  // activity, otherwise the ledger snapshot goes stale.
  await satisfyManualCashReconciliation({ companyId, fiscalPeriodId, userId })
  const canonicalPreviewId = previewId
    ?? await createCanonicalPreview(companyId, fiscalPeriodId, userId)
  const { rows } = await getPool().query(
    `SELECT public.execute_year_end_closing(
       $1::uuid, $2::uuid, $3::uuid, $4, NULL, $5::uuid
     ) AS result`,
    [companyId, fiscalPeriodId, userId, idempotencyKey, canonicalPreviewId],
  )
  return rows[0].result as Record<string, unknown>
}

async function createCanonicalPreview(
  companyId: string,
  fiscalPeriodId: string,
  userId: string,
): Promise<string> {
  const { rows: existing } = await getPool().query<{ id: string }>(
    `SELECT id
     FROM public.year_end_previews
     WHERE company_id = $1 AND fiscal_period_id = $2
     ORDER BY generated_at DESC
     LIMIT 1`,
    [companyId, fiscalPeriodId],
  )
  if (existing[0]?.id) return existing[0].id

  const { rows } = await getPool().query<{ result: { preview_id: string } }>(
    `SELECT public.create_year_end_preview(
       $1::uuid, $2::uuid, $3::uuid, '{}'::jsonb
     ) AS result`,
    [companyId, fiscalPeriodId, userId],
  )
  return rows[0].result.preview_id
}

async function stageAdjustmentGroup(
  companyId: string,
  fiscalPeriodId: string,
  userId: string,
  group: 'accrual' | 'disposition' | 'tax',
  items: unknown[],
): Promise<void> {
  await getPool().query(
    `SELECT public.stage_year_end_adjustments(
       $1::uuid, $2::uuid, $3::uuid, $4::text, $5::jsonb
     )`,
    [companyId, fiscalPeriodId, userId, group, JSON.stringify(items)],
  )
}

describe('execute_year_end_closing (atomic close)', () => {
  it('posts disposition, tax and accrual separately before one canonical closing entry', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await postSimpleActivity({ userId, companyId, fiscalPeriodId })

    await stageAdjustmentGroup(companyId, fiscalPeriodId, userId, 'disposition', [
      {
        stable_key: 'pg-disposition-1',
        adjustment_kind: 'periodiseringsfond',
        description: 'Avsättning till periodiseringsfond',
        journal_lines: [
          { account_number: '8811', debit_amount: 100, credit_amount: 0 },
          { account_number: '2120', debit_amount: 0, credit_amount: 100 },
        ],
      },
      {
        stable_key: 'pg-disposition-2',
        adjustment_kind: 'overavskrivning',
        description: 'Förändring överavskrivning',
        journal_lines: [
          { account_number: '8850', debit_amount: 40, credit_amount: 0 },
          { account_number: '2150', debit_amount: 0, credit_amount: 40 },
        ],
      },
    ])
    await stageAdjustmentGroup(companyId, fiscalPeriodId, userId, 'tax', [{
      stable_key: 'pg-tax-1',
      adjustment_kind: 'bolagsskatt',
      description: 'Beräknad bolagsskatt',
      journal_lines: [
        { account_number: '8910', debit_amount: 50, credit_amount: 0 },
        { account_number: '2510', debit_amount: 0, credit_amount: 50 },
      ],
    }])
    await stageAdjustmentGroup(companyId, fiscalPeriodId, userId, 'accrual', [{
      stable_key: 'pg-accrual-1',
      adjustment_kind: 'manual_accrual',
      description: 'Upplupen kostnad',
      reversal_date: '2026-01-01',
      journal_lines: [
        { account_number: '6990', debit_amount: 25, credit_amount: 0 },
        { account_number: '2990', debit_amount: 0, credit_amount: 25 },
      ],
    }])

    const result = await closePeriodViaRpc(
      companyId,
      fiscalPeriodId,
      userId,
      'adjustments-combined',
    )
    expect(result.status).toBe('closed')

    const { rows } = await getPool().query<{ source_type: string; count: string }>(
      `SELECT source_type, count(*)::text AS count
       FROM public.journal_entries
       WHERE company_id = $1 AND fiscal_period_id = $2 AND status = 'posted'
         AND source_type IN (
           'year_end_accrual', 'year_end_disposition',
           'year_end_tax_adjustment', 'year_end_closing'
         )
       GROUP BY source_type`,
      [companyId, fiscalPeriodId],
    )
    expect(Object.fromEntries(rows.map((row) => [row.source_type, Number(row.count)]))).toEqual({
      year_end_accrual: 1,
      year_end_closing: 1,
      year_end_disposition: 2,
      year_end_tax_adjustment: 1,
    })
  })

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

    const previewId = await createCanonicalPreview(companyId, fiscalPeriodId, userId)
    const first = await closePeriodViaRpc(
      companyId,
      fiscalPeriodId,
      userId,
      'retry-key',
      previewId,
    )
    const replay = await closePeriodViaRpc(
      companyId,
      fiscalPeriodId,
      userId,
      'retry-key',
      previewId,
    )
    expect(replay.idempotent).toBe(true)
    expect(replay.closing_entry_id).toBe(first.closing_entry_id)

    await expect(
      closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'different-key'),
    ).rejects.toThrow(/YE_ALREADY_CLOSED/)

    // Still exactly one closing entry + one IB.
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.journal_entries
       WHERE company_id = $1 AND source_type = 'year_end_closing' AND status = 'posted'`,
      [companyId],
    )
    expect(rows[0].n).toBe(1)
  })

  it('two concurrent closes yield exactly one closing entry and one IB (B09)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await postSimpleActivity({ userId, companyId, fiscalPeriodId })
    const previewId = await createCanonicalPreview(companyId, fiscalPeriodId, userId)

    const results = await Promise.allSettled([
      closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'conc-key', previewId),
      closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'conc-key', previewId),
    ])
    // Both should resolve (second is an idempotent replay after the advisory
    // lock releases) — or the second may fail with ALREADY_CLOSED if it used
    // a different key. With the same key both succeed.
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled.length).toBe(2)

    const pool = getPool()
    const { rows: closing } = await pool.query(
      `SELECT count(*)::int AS n FROM public.journal_entries
       WHERE company_id = $1 AND source_type = 'year_end_closing' AND status = 'posted'`,
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
    ).rejects.toThrow(/YE_READINESS_BLOCKED: draft_entries/)

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
       WHERE company_id = $1 AND source_type IN ('year_end_closing','opening_balance')`,
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
    ).rejects.toThrow(/YE_READINESS_BLOCKED: next_period_has_ob/)

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
       WHERE company_id = $1 AND source_type = 'year_end_closing'`,
      [companyId],
    )
    expect(yeEntries[0].n).toBe(0)
  })

  it('reuses an existing exact opening balance and repairs the missing period link', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await postSimpleActivity({ userId, companyId, fiscalPeriodId })
    const nextPeriodId = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      name: '2026',
    })
    const existingObId = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, 0, 'A', '2026-01-01', 'Existing exact IB',
         'opening_balance', 'draft')`,
      [existingObId, userId, companyId, nextPeriodId],
    )
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       VALUES ($1, '1930', 1000, 0), ($1, '2099', 0, 1000)`,
      [existingObId],
    )
    await getPool().query(
      `SELECT * FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
      [companyId, existingObId],
    )

    const result = await closePeriodViaRpc(
      companyId,
      fiscalPeriodId,
      userId,
      'reuse-ob-key',
    )
    expect(result.opening_balance_entry_id).toBe(existingObId)
    expect(result.opening_balance_created).toBe(false)
    expect(result.next_period_created).toBe(false)

    const { rows } = await getPool().query(
      `SELECT opening_balance_entry_id, continuity_verified
       FROM public.fiscal_periods WHERE id = $1`,
      [nextPeriodId],
    )
    expect(rows[0].opening_balance_entry_id).toBe(existingObId)
    expect(rows[0].continuity_verified).toBe(true)
  })

  it('rejects a future period separated by a date gap and rolls back the close', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await postSimpleActivity({ userId, companyId, fiscalPeriodId })
    await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: '2026-02-01',
      periodEnd: '2027-01-31',
      name: 'Gap year',
    })

    await expect(
      closePeriodViaRpc(companyId, fiscalPeriodId, userId, 'gap-key'),
    ).rejects.toThrow(/YE_NEXT_PERIOD_NOT_CONTIGUOUS/)

    const { rows } = await getPool().query(
      `SELECT is_closed, closing_entry_id FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(rows[0]).toMatchObject({ is_closed: false, closing_entry_id: null })
  })

  it('exposes execute only to service_role and uses the seven-argument signature', async () => {
    const { rows } = await getPool().query(
      `SELECT
         to_regprocedure(
           'public.execute_year_end_closing(uuid,uuid,uuid,text,jsonb,uuid,text)'
         ) IS NOT NULL AS signature_exists,
         has_function_privilege(
           'authenticated',
           'public.execute_year_end_closing(uuid,uuid,uuid,text,jsonb,uuid,text)',
           'EXECUTE'
         ) AS authenticated_can_execute,
         has_function_privilege(
           'service_role',
           'public.execute_year_end_closing(uuid,uuid,uuid,text,jsonb,uuid,text)',
           'EXECUTE'
         ) AS service_role_can_execute`,
    )
    expect(rows[0]).toEqual({
      signature_exists: true,
      authenticated_can_execute: false,
      service_role_can_execute: true,
    })
  })

  it('DB unique index blocks a second posted year_end_closing entry per period', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // Insert one posted year_end_closing entry directly into the OPEN period (with
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
           VALUES ($1, $2, $3, $4, $5, 'A', '2025-12-31', 'Close', 'year_end_closing', 'posted', now())`,
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
        /journal_entries_one_year_end_closing_per_period|duplicate key/,
      )
      await client.query('ROLLBACK').catch(() => {})
    } finally {
      client.release()
    }
  })
})

describe('post_currency_revaluation (database-verified FX snapshot, B05)', () => {
  async function callReval(
    companyId: string,
    periodId: string,
    userId: string,
    clientSnapshotKey: string,
    lines: unknown[] = [],
    items: unknown[] = [],
  ): Promise<Record<string, unknown>> {
    const { rows } = await getPool().query(
      `SELECT public.post_currency_revaluation(
         $1::uuid, $2::uuid, $3::uuid, '2025-12-31'::date,
         $4, $5::jsonb, $6::jsonb
       ) AS result`,
      [companyId, periodId, userId, clientSnapshotKey, JSON.stringify(lines), JSON.stringify(items)],
    )
    return rows[0].result as Record<string, unknown>
  }

  it('derives the canonical empty snapshot in PostgreSQL and reuses it regardless of a client key', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const first = await callReval(companyId, fiscalPeriodId, userId, 'client-key-1')
    expect(first.reused).toBe(false)
    expect(first.entry_id).toBeNull()
    expect(first.snapshot_key).not.toBe('client-key-1')

    const replay = await callReval(companyId, fiscalPeriodId, userId, 'manipulated-client-key')
    expect(replay.reused).toBe(true)
    expect(replay.entry_id).toBeNull()
    expect(replay.run_id).toBe(first.run_id)
    expect(replay.snapshot_key).toBe(first.snapshot_key)
  })

  it('rejects balanced but client-invented journal lines when the database has no FX exposure', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const inventedLines = [
      { account_number: '1510', debit_amount: 100, credit_amount: 0, line_description: 'FX' },
      { account_number: '3960', debit_amount: 0, credit_amount: 100, line_description: 'FX gain' },
    ]

    await expect(
      callReval(companyId, fiscalPeriodId, userId, 'client-key', inventedLines),
    ).rejects.toThrow(/FX_LINES_MISMATCH/)

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n
       FROM public.journal_entries
       WHERE company_id = $1 AND source_type = 'currency_revaluation'`,
      [companyId],
    )
    expect(rows[0].n).toBe(0)
  })

  it('refuses to revalue a closed/locked period', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany({ isClosed: true })
    await expect(
      callReval(companyId, fiscalPeriodId, userId, 'client-key'),
    ).rejects.toThrow(/FX_PERIOD_CLOSED/)
  })
})

describe('FX verification through the atomic close (B01 + B08)', () => {
  it('rejects a manipulated FX payload before closing and leaves the period economically untouched', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    await postSimpleActivity({ userId, companyId, fiscalPeriodId })

    const manipulated = {
      balance_date: '2025-12-31',
      snapshot_key: 'attacker-controlled',
      lines: [
        { account_number: '1510', debit_amount: 250, credit_amount: 0, line_description: 'FX' },
        { account_number: '3960', debit_amount: 0, credit_amount: 250, line_description: 'FX gain' },
      ],
      items: [],
    }
    const previewId = await createCanonicalPreview(companyId, fiscalPeriodId, userId)

    await expect(
      getPool().query(
        `SELECT public.execute_year_end_closing(
           $1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::uuid
         ) AS result`,
        [
          companyId,
          fiscalPeriodId,
          userId,
          'fx-close-key',
          JSON.stringify(manipulated),
          previewId,
        ],
      ),
    ).rejects.toThrow(/FX_LINES_MISMATCH/)

    const { rows: periodRows } = await getPool().query(
      `SELECT is_closed, locked_at, closing_entry_id
       FROM public.fiscal_periods WHERE id = $1`,
      [fiscalPeriodId],
    )
    expect(periodRows[0]).toMatchObject({
      is_closed: false,
      locked_at: null,
      closing_entry_id: null,
    })

    const { rows: entries } = await getPool().query(
      `SELECT count(*)::int AS n
       FROM public.journal_entries
       WHERE fiscal_period_id = $1
         AND source_type IN ('year_end', 'year_end_closing', 'currency_revaluation')`,
      [fiscalPeriodId],
    )
    expect(entries[0].n).toBe(0)
  })
})
