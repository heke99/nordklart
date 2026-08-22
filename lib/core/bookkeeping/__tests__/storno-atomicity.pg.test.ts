import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withServiceRole } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertChartAccounts,
  insertCompany,
  insertCompanyMember,
  insertCompanySettings,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

/**
 * reverse_journal_entry_v2 — storno and rättelse in one transaction.
 *
 * The old path was next_voucher_number → INSERT header → INSERT lines →
 * UPDATE status='posted' → CAS on the original, with cancelEntry() as the
 * compensation between steps. Three things it could not guarantee, and which
 * these tests exist to pin:
 *
 *   1. A rejected storno leaves NOTHING behind — no journal entry in any
 *      status, not even a cancelled one.
 *   2. A rejected storno burns NO voucher number. The old code called
 *      next_voucher_number first, so every later failure left a gap that
 *      BFNAR 2013:2 then requires someone to explain in writing.
 *   3. Posting goes through commit_journal_entry, so the authorization it
 *      carries actually applies. `UPDATE status='posted'` skipped it.
 */

async function seed() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertCompanySettings({ companyId })
  await insertChartAccounts({ userId, companyId })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    name: '2026',
  })
  return { userId, companyId, fiscalPeriodId }
}

/** A posted 1930/3001 voucher to storno. */
async function postOriginal(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  amount?: number
}): Promise<string> {
  const amount = params.amount ?? 1000
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-15', 'Original', 'manual', 'draft')`,
    [id, params.userId, params.companyId, params.fiscalPeriodId],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
     VALUES ($1, '1930', $2, 0, 0), ($1, '3001', 0, $2, 1)`,
    [id, amount],
  )
  await getPool().query(
    `SELECT public.commit_journal_entry($1::uuid, $2::uuid, 'user_accept')`,
    [params.companyId, id],
  )
  return id
}

function reversalPlan(fiscalPeriodId: string, amount = 1000) {
  return {
    fiscal_period_id: fiscalPeriodId,
    entry_date: '2026-06-15',
    description: 'Storno: Original',
    source_type: 'storno',
    source_id: null,
    voucher_series: 'A',
    lines: [
      { account_number: '1930', debit_amount: 0, credit_amount: amount },
      { account_number: '3001', debit_amount: amount, credit_amount: 0 },
    ],
  }
}

function correctionPlan(fiscalPeriodId: string, amount = 900) {
  return {
    fiscal_period_id: fiscalPeriodId,
    entry_date: '2026-06-15',
    description: 'Rättelse: Original',
    source_type: 'correction',
    source_id: null,
    voucher_series: 'A',
    lines: [
      { account_number: '1930', debit_amount: amount, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: amount },
    ],
  }
}

async function countEntries(companyId: string, sourceType: string): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(
    `SELECT count(*) AS n FROM public.journal_entries
      WHERE company_id = $1 AND source_type = $2`,
    [companyId, sourceType],
  )
  return Number(rows[0]!.n)
}

async function peekNextVoucher(companyId: string, fiscalPeriodId: string): Promise<number> {
  const { rows } = await getPool().query<{ last_number: number | null }>(
    `SELECT last_number FROM public.voucher_sequences
      WHERE company_id = $1 AND fiscal_period_id = $2 AND voucher_series = 'A'`,
    [companyId, fiscalPeriodId],
  )
  return rows[0]?.last_number ?? 0
}

describe('reverse_journal_entry_v2 (pg-real)', () => {
  it('posts the storno and flips the original in one transaction', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const originalId = await postOriginal({ userId, companyId, fiscalPeriodId })

    const result = await withServiceRole(async (client) => {
      const { rows } = await client.query<{ reverse_journal_entry_v2: { reversal_entry_id: string; correction_entry_id: string | null } }>(
        `SELECT public.reverse_journal_entry_v2($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date)`,
        [companyId, userId, originalId, JSON.stringify(reversalPlan(fiscalPeriodId)), '2026-06-15'],
      )
      return rows[0]!.reverse_journal_entry_v2
    })

    expect(result.reversal_entry_id).toBeTruthy()
    expect(result.correction_entry_id).toBeNull()

    const { rows } = await getPool().query(
      `SELECT id, status, reverses_id, reversed_by_id, voucher_number, commit_method
         FROM public.journal_entries WHERE company_id = $1 ORDER BY voucher_number`,
      [companyId],
    )
    const original = rows.find((r) => r.id === originalId)!
    const storno = rows.find((r) => r.id === result.reversal_entry_id)!

    expect(original.status).toBe('reversed')
    expect(original.reversed_by_id).toBe(storno.id)
    expect(storno.status).toBe('posted')
    expect(storno.reverses_id).toBe(originalId)
    // Posted through commit_journal_entry, not a bare status update — which is
    // what makes the provenance and the authorization inside it apply at all.
    expect(storno.commit_method).toBe('atomic_storno')
    expect(storno.voucher_number).toBeGreaterThan(0)
  })

  it('posts storno + rättelse together and links both to the original', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const originalId = await postOriginal({ userId, companyId, fiscalPeriodId })

    const result = await withServiceRole(async (client) => {
      const { rows } = await client.query<{ reverse_journal_entry_v2: { reversal_entry_id: string; correction_entry_id: string | null } }>(
        `SELECT public.reverse_journal_entry_v2($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date, $6::jsonb, $7::date)`,
        [
          companyId, userId, originalId,
          JSON.stringify(reversalPlan(fiscalPeriodId)), '2026-06-15',
          JSON.stringify(correctionPlan(fiscalPeriodId)), '2026-06-15',
        ],
      )
      return rows[0]!.reverse_journal_entry_v2
    })

    expect(result.correction_entry_id).toBeTruthy()

    const { rows } = await getPool().query(
      `SELECT id, status, source_type, correction_of_id, commit_method
         FROM public.journal_entries WHERE company_id = $1`,
      [companyId],
    )
    const correction = rows.find((r) => r.id === result.correction_entry_id)!
    expect(correction.status).toBe('posted')
    expect(correction.source_type).toBe('correction')
    expect(correction.correction_of_id).toBe(originalId)
    expect(correction.commit_method).toBe('atomic_correction')
  })

  // The point of the whole change. Each rejection route must leave the ledger
  // exactly as it was — and, unlike the old multi-write path, must not have
  // consumed a voucher number on the way out.
  const rejections: Array<{
    name: string
    build: (ctx: { companyId: string; userId: string; fiscalPeriodId: string; originalId: string }) => unknown[]
  }> = [
    {
      name: 'unbalanced storno plan',
      build: ({ companyId, userId, fiscalPeriodId, originalId }) => {
        const plan = reversalPlan(fiscalPeriodId)
        plan.lines[1]!.debit_amount = 999
        return [companyId, userId, originalId, JSON.stringify(plan), '2026-06-15']
      },
    },
    {
      name: 'account outside the chart of accounts',
      build: ({ companyId, userId, fiscalPeriodId, originalId }) => {
        const plan = reversalPlan(fiscalPeriodId)
        plan.lines[0]!.account_number = '9999'
        return [companyId, userId, originalId, JSON.stringify(plan), '2026-06-15']
      },
    },
    {
      name: 'wrong source_type in the plan',
      build: ({ companyId, userId, fiscalPeriodId, originalId }) => {
        const plan = reversalPlan(fiscalPeriodId)
        plan.source_type = 'manual'
        return [companyId, userId, originalId, JSON.stringify(plan), '2026-06-15']
      },
    },
    {
      name: 'entry date that does not match the plan',
      build: ({ companyId, userId, fiscalPeriodId, originalId }) => [
        companyId, userId, originalId, JSON.stringify(reversalPlan(fiscalPeriodId)), '2026-07-01',
      ],
    },
    {
      name: 'unbalanced correction plan',
      build: ({ companyId, userId, fiscalPeriodId, originalId }) => {
        const plan = correctionPlan(fiscalPeriodId)
        plan.lines[1]!.credit_amount = 1
        return [
          companyId, userId, originalId,
          JSON.stringify(reversalPlan(fiscalPeriodId)), '2026-06-15',
          JSON.stringify(plan), '2026-06-15',
        ]
      },
    },
  ]

  for (const rejection of rejections) {
    it(`leaves no voucher and burns no number — ${rejection.name}`, async () => {
      const { userId, companyId, fiscalPeriodId } = await seed()
      const originalId = await postOriginal({ userId, companyId, fiscalPeriodId })
      const voucherBefore = await peekNextVoucher(companyId, fiscalPeriodId)

      const args = rejection.build({ companyId, userId, fiscalPeriodId, originalId })
      const sql = args.length > 5
        ? `SELECT public.reverse_journal_entry_v2($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date, $6::jsonb, $7::date)`
        : `SELECT public.reverse_journal_entry_v2($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date)`

      await expect(
        withServiceRole((client) => client.query(sql, args)),
      ).rejects.toThrow()

      expect(await countEntries(companyId, 'storno')).toBe(0)
      expect(await countEntries(companyId, 'correction')).toBe(0)
      expect(await peekNextVoucher(companyId, fiscalPeriodId)).toBe(voucherBefore)

      const { rows } = await getPool().query<{ status: string }>(
        `SELECT status FROM public.journal_entries WHERE id = $1`,
        [originalId],
      )
      expect(rows[0]!.status).toBe('posted')
    })
  }

  it('refuses to reverse an entry that is already reversed', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const originalId = await postOriginal({ userId, companyId, fiscalPeriodId })

    await withServiceRole((client) =>
      client.query(
        `SELECT public.reverse_journal_entry_v2($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date)`,
        [companyId, userId, originalId, JSON.stringify(reversalPlan(fiscalPeriodId)), '2026-06-15'],
      ))

    const stornoCountBefore = await countEntries(companyId, 'storno')

    await expect(
      withServiceRole((client) =>
        client.query(
          `SELECT public.reverse_journal_entry_v2($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date)`,
          [companyId, userId, originalId, JSON.stringify(reversalPlan(fiscalPeriodId)), '2026-06-15'],
        )),
    ).rejects.toThrow(/already reversed/i)

    expect(await countEntries(companyId, 'storno')).toBe(stornoCountBefore)
  })

  it('refuses an actor who cannot write the company', async () => {
    const { companyId, fiscalPeriodId, userId } = await seed()
    const originalId = await postOriginal({ userId, companyId, fiscalPeriodId })
    const outsiderId = await insertAuthUser()

    await expect(
      withServiceRole((client) =>
        client.query(
          `SELECT public.reverse_journal_entry_v2($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date)`,
          [companyId, outsiderId, originalId, JSON.stringify(reversalPlan(fiscalPeriodId)), '2026-06-15'],
        )),
    ).rejects.toThrow(/cannot write this company/i)

    expect(await countEntries(companyId, 'storno')).toBe(0)
  })

  it('is unreachable without service_role', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const originalId = await postOriginal({ userId, companyId, fiscalPeriodId })

    await expect(
      getPool().query(
        `SELECT public.reverse_journal_entry_v2($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::date)`,
        [companyId, userId, originalId, JSON.stringify(reversalPlan(fiscalPeriodId)), '2026-06-15'],
      ),
    ).rejects.toThrow()
  })
})
