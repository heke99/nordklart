import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCashAccount,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertTransaction,
} from '@/tests/pg/fixtures'

async function seedReadyCompany() {
  const pool = getPool()
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await pool.query(
    `UPDATE public.companies
        SET org_number = '5594167149', accounting_framework = 'k2'
      WHERE id = $1`,
    [companyId],
  )
  await pool.query(
    `INSERT INTO public.company_settings
       (company_id, user_id, company_name, org_number, entity_type, accounting_method)
     VALUES ($1, $2, 'Test AB', '5594167149', 'aktiebolag', 'accrual')
     ON CONFLICT (company_id) DO UPDATE SET accounting_method = EXCLUDED.accounting_method`,
    [companyId, userId],
  )
  await pool.query(
    `INSERT INTO public.company_entitlements
       (company_id, feature_code, source, enabled, granted_by)
     VALUES ($1, 'year_end.projects', 'manual_override', true, $2)`,
    [companyId, userId],
  )
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    name: '2025',
  })
  const cashAccountId = await insertCashAccount({
    companyId,
    ledgerAccount: '1930',
    currency: 'SEK',
    isPrimary: true,
  })
  return { userId, companyId, fiscalPeriodId, cashAccountId }
}

async function postEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  account: string
  amount: number
  entryDate?: string
}): Promise<string> {
  const pool = getPool()
  const entryId = randomUUID()
  await pool.query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Readiness test', 'manual', 'draft')`,
    [entryId, params.userId, params.companyId, params.fiscalPeriodId, params.entryDate ?? '2025-06-01'],
  )
  await pool.query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, $2, $3, 0), ($1, '3001', 0, $3)`,
    [entryId, params.account, params.amount],
  )
  await pool.query(`SELECT * FROM public.commit_journal_entry($1::uuid, $2::uuid)`, [params.companyId, entryId])
  return entryId
}

async function blockerCodes(companyId: string, fiscalPeriodId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ code: string }>(
    `SELECT code FROM public.year_end_db_blockers($1::uuid, $2::uuid)`,
    [companyId, fiscalPeriodId],
  )
  return rows.map((row) => row.code)
}

describe('year-end database readiness reconciliation hardening', () => {
  beforeEach(async () => {
    // No shared state. Each test owns its company and fiscal year.
  })

  it('executes historical open-item reconstruction without output-column ambiguity', async () => {
    const seeded = await seedReadyCompany()

    const { rows } = await getPool().query(
      `SELECT source_type, source_id, open_amount
         FROM public.historical_open_items_at($1::uuid, DATE '2025-12-31')`,
      [seeded.companyId],
    )

    expect(rows).toEqual([])
    await expect(blockerCodes(seeded.companyId, seeded.fiscalPeriodId)).resolves.toBeDefined()
  })

  it('blocks an unmatched bank-side transaction even when the amount could net against another row', async () => {
    const seeded = await seedReadyCompany()
    await insertTransaction({
      companyId: seeded.companyId,
      userId: seeded.userId,
      cashAccountId: seeded.cashAccountId,
      amount: 100,
      date: '2025-06-01',
    })
    await insertTransaction({
      companyId: seeded.companyId,
      userId: seeded.userId,
      cashAccountId: seeded.cashAccountId,
      amount: -100,
      date: '2025-06-02',
    })

    expect(await blockerCodes(seeded.companyId, seeded.fiscalPeriodId)).toContain('bank_unmatched_transactions')
  })

  it('blocks an unmatched general-ledger cash line', async () => {
    const seeded = await seedReadyCompany()
    await postEntry({ ...seeded, account: '1930', amount: 500 })

    expect(await blockerCodes(seeded.companyId, seeded.fiscalPeriodId)).toContain('bank_unmatched_gl_lines')
  })

  it('blocks a non-zero bank difference even when both sides are linked', async () => {
    const seeded = await seedReadyCompany()
    const entryId = await postEntry({ ...seeded, account: '1930', amount: 500 })
    await insertTransaction({
      companyId: seeded.companyId,
      userId: seeded.userId,
      cashAccountId: seeded.cashAccountId,
      journalEntryId: entryId,
      amount: 499,
      date: '2025-06-01',
    })

    expect(await blockerCodes(seeded.companyId, seeded.fiscalPeriodId)).toContain('bank_reconciliation_difference')
  })

  it('blocks when historical AR does not reconcile to account 1510', async () => {
    const seeded = await seedReadyCompany()
    await postEntry({ ...seeded, account: '1510', amount: 1_000 })

    expect(await blockerCodes(seeded.companyId, seeded.fiscalPeriodId)).toContain('accounts_receivable_mismatch')
  })

  it('increments durable retry metadata for repeated failed close attempts', async () => {
    const seeded = await seedReadyCompany()
    const key = `retry-${randomUUID()}`
    for (let i = 0; i < 2; i++) {
      await getPool().query(
        `SELECT public.record_year_end_failure(
           $1::uuid, $2::uuid, $3::uuid, $4, 'closing', 'TEST_FAILURE',
           'technical', 'user message', $5, false
         )`,
        [seeded.companyId, seeded.fiscalPeriodId, seeded.userId, key, `corr-${i}`],
      )
    }

    const { rows } = await getPool().query<{ retry_count: number; last_retry_at: Date | null }>(
      `SELECT retry_count, last_retry_at
         FROM public.year_end_runs
        WHERE company_id = $1 AND fiscal_period_id = $2 AND idempotency_key = $3
        ORDER BY created_at`,
      [seeded.companyId, seeded.fiscalPeriodId, key],
    )
    expect(rows.map((row) => row.retry_count)).toEqual([0, 1])
    expect(rows[1]?.last_retry_at).not.toBeNull()
  })
})
