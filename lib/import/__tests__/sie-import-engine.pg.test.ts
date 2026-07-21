import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

// SIE import through the central posting engine (revision items I01–I12).
//
// Covers:
//   - finalize_sie_import posts staged vouchers ATOMICALLY with provenance
//     (sie_import_id + external_reference) and sequential voucher numbers.
//   - Idempotent retry: already-posted external references are skipped.
//   - An unbalanced staged voucher aborts the WHOLE finalize (nothing posts).
//   - Atomic replace: the old import is reversed without hard deletion and the
//     corrected import is posted in the same transaction.
//   - Undo creates exact storno entries for only the selected import.
//   - The deferred balance guard makes a direct posted INSERT without
//     balanced lines impossible (I03).
//   - complete_sie_import refuses 'completed' without archive (I18).

async function seed(): Promise<{
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
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    name: '2025',
  })
  return { userId, companyId, fiscalPeriodId }
}

async function insertImportRow(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string | null
  status?: string
  fileHash?: string
  replaces?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type,
        fiscal_year_start, fiscal_year_end, status, fiscal_period_id, replaces_import_id)
     VALUES ($1, $2, $3, 'test.se', $4, 4, '2025-01-01', '2025-12-31', $5, $6, $7)`,
    [
      id,
      params.userId,
      params.companyId,
      params.fileHash ?? randomUUID(),
      params.status ?? 'pending',
      params.fiscalPeriodId,
      params.replaces ?? null,
    ],
  )
  return id
}

function voucher(
  series: string,
  number: number,
  date: string,
  lines: Array<{ account: string; debit: number; credit: number }>,
): Record<string, unknown> {
  return {
    external_reference: `${series}:${number}:${date}`,
    voucher_series: series,
    entry_date: date,
    description: `Voucher ${series}${number}`,
    source_voucher_series: series,
    source_voucher_number: String(number),
    lines: lines.map((l) => ({
      account_number: l.account,
      debit_amount: l.debit,
      credit_amount: l.credit,
      line_description: null,
    })),
  }
}

async function stage(
  importId: string,
  companyId: string,
  vouchers: Array<Record<string, unknown>>,
): Promise<void> {
  for (let i = 0; i < vouchers.length; i++) {
    await getPool().query(
      `INSERT INTO public.sie_import_staging (import_id, company_id, row_index, voucher)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (import_id, row_index) DO NOTHING`,
      [importId, companyId, i, JSON.stringify(vouchers[i])],
    )
  }
}

async function finalize(
  companyId: string,
  importId: string,
  userId: string,
  options: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query(
    `SELECT public.finalize_sie_import($1::uuid, $2::uuid, $3::uuid, $4::jsonb) AS result`,
    [companyId, importId, userId, JSON.stringify(options)],
  )
  return rows[0].result as Record<string, unknown>
}

describe('finalize_sie_import (atomic staged posting)', () => {
  it('posts staged vouchers with provenance, voucher numbers and correct counters', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const importId = await insertImportRow({ companyId, userId, fiscalPeriodId })
    await stage(importId, companyId, [
      voucher('A', 1, '2025-02-01', [
        { account: '1930', debit: 100, credit: 0 },
        { account: '3001', debit: 0, credit: 100 },
      ]),
      voucher('A', 2, '2025-03-01', [
        { account: '5010', debit: 50, credit: 0 },
        { account: '1930', debit: 0, credit: 50 },
      ]),
    ])

    const result = await finalize(companyId, importId, userId, {
      skip_duplicates: true,
      expected_voucher_count: 2,
    })
    expect(result.posted).toBe(2)
    expect(result.skipped_duplicates).toBe(0)

    const { rows } = await getPool().query(
      `SELECT voucher_number, external_reference, status, sie_import_id
       FROM public.journal_entries
       WHERE company_id = $1 AND sie_import_id = $2
       ORDER BY voucher_number`,
      [companyId, importId],
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].status).toBe('posted')
    expect(rows[0].voucher_number).toBe(1)
    expect(rows[1].voucher_number).toBe(2)
    expect(rows[0].external_reference).toBe('A:1:2025-02-01')

    // Staging cleared.
    const { rows: staged } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.sie_import_staging WHERE import_id = $1`,
      [importId],
    )
    expect(staged[0].n).toBe(0)
  })

  it('idempotent retry skips already-posted external references (I05)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const importId = await insertImportRow({ companyId, userId, fiscalPeriodId })
    const v = voucher('A', 1, '2025-02-01', [
      { account: '1930', debit: 100, credit: 0 },
      { account: '3001', debit: 0, credit: 100 },
    ])
    await stage(importId, companyId, [v])
    const first = await finalize(companyId, importId, userId)
    expect(first.posted).toBe(1)

    // Simulate a retry: import back to 'staged', voucher staged again.
    await getPool().query(`UPDATE public.sie_imports SET status = 'staged' WHERE id = $1`, [
      importId,
    ])
    await stage(importId, companyId, [v])
    const retry = await finalize(companyId, importId, userId)
    expect(retry.posted).toBe(0)
    expect(retry.skipped_duplicates).toBe(1)

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.journal_entries WHERE sie_import_id = $1`,
      [importId],
    )
    expect(rows[0].n).toBe(1)
  })

  it('an unbalanced staged voucher aborts the WHOLE finalize — nothing posts (I01/I11)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const importId = await insertImportRow({ companyId, userId, fiscalPeriodId })
    await stage(importId, companyId, [
      voucher('A', 1, '2025-02-01', [
        { account: '1930', debit: 100, credit: 0 },
        { account: '3001', debit: 0, credit: 100 },
      ]),
      voucher('A', 2, '2025-03-01', [
        { account: '5010', debit: 50, credit: 0 },
        { account: '1930', debit: 0, credit: 49 }, // 1 SEK unbalanced
      ]),
    ])

    await expect(finalize(companyId, importId, userId)).rejects.toThrow(/SIE_UNBALANCED/)

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.journal_entries WHERE sie_import_id = $1`,
      [importId],
    )
    expect(rows[0].n).toBe(0)
  })

  it('a voucher dated outside the fiscal period aborts the finalize', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const importId = await insertImportRow({ companyId, userId, fiscalPeriodId })
    await stage(importId, companyId, [
      voucher('A', 1, '2026-02-01', [
        { account: '1930', debit: 100, credit: 0 },
        { account: '3001', debit: 0, credit: 100 },
      ]),
    ])
    await expect(finalize(companyId, importId, userId)).rejects.toThrow(
      /SIE_DATE_OUTSIDE_PERIOD/,
    )
  })

  it('atomic replace reverses exactly the old import and posts the corrected file (I06/I07)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const oldImport = await insertImportRow({ companyId, userId, fiscalPeriodId, status: 'staged' })
    await stage(oldImport, companyId, [
      voucher('A', 1, '2025-02-01', [
        { account: '1930', debit: 100, credit: 0 },
        { account: '3001', debit: 0, credit: 100 },
      ]),
      voucher('A', 2, '2025-03-01', [
        { account: '5010', debit: 60, credit: 0 },
        { account: '1930', debit: 0, credit: 60 },
      ]),
    ])
    await finalize(companyId, oldImport, userId)
    await getPool().query(
      `SELECT public.complete_sie_import($1::uuid,$2::uuid,'completed',NULL,'[]'::jsonb,true,NULL,'old.se')`,
      [companyId, oldImport],
    )

    const manualId = randomUUID()
    await getPool().query(
      `WITH entry AS (
         INSERT INTO public.journal_entries
           (id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,
            entry_date,description,source_type,status,committed_at)
         VALUES ($1,$2,$3,$4,500,'M','2025-05-01','Manual','manual','posted',now())
         RETURNING id
       )
       INSERT INTO public.journal_entry_lines
         (journal_entry_id,account_number,debit_amount,credit_amount)
       SELECT id,'1930',10,0 FROM entry
       UNION ALL SELECT id,'3001',0,10 FROM entry`,
      [manualId, userId, companyId, fiscalPeriodId],
    )

    const replacement = await insertImportRow({
      companyId, userId, fiscalPeriodId, status: 'staged', replaces: oldImport,
    })
    await stage(replacement, companyId, [
      voucher('A', 1, '2025-02-01', [
        { account: '1930', debit: 200, credit: 0 },
        { account: '3001', debit: 0, credit: 200 },
      ]),
    ])
    const result = await finalize(companyId, replacement, userId, { replaces_import_id: oldImport })
    expect(result.deleted_from_replaced).toBe(2) // compatibility field; now means reversed
    expect(result.posted).toBe(1)

    const { rows: oldRows } = await getPool().query(
      `SELECT source_type,status,reverses_id,reversed_by_id
       FROM public.journal_entries WHERE sie_import_id=$1 ORDER BY source_type,status`,
      [oldImport],
    )
    expect(oldRows.filter((row) => row.source_type !== 'storno')).toHaveLength(2)
    expect(oldRows.filter((row) => row.source_type !== 'storno').every((row) => row.status === 'reversed')).toBe(true)
    expect(oldRows.filter((row) => row.source_type === 'storno' && row.status === 'posted')).toHaveLength(2)

    const { rows: links } = await getPool().query(
      `SELECT original_entry_id,reversal_entry_id FROM public.sie_import_entry_reversals
       WHERE company_id=$1 AND sie_import_id=$2`,
      [companyId, oldImport],
    )
    expect(links).toHaveLength(2)

    const { rows: manualRows } = await getPool().query(
      `SELECT status FROM public.journal_entries WHERE id=$1`, [manualId],
    )
    expect(manualRows[0].status).toBe('posted')
  })

  it('a failing replacement leaves the old bookkeeping economically valid (I06)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const oldImport = await insertImportRow({ companyId, userId, fiscalPeriodId, status: 'staged' })
    await stage(oldImport, companyId, [voucher('A', 1, '2025-02-01', [
      { account: '1930', debit: 100, credit: 0 },
      { account: '3001', debit: 0, credit: 100 },
    ])])
    await finalize(companyId, oldImport, userId)
    await getPool().query(
      `SELECT public.complete_sie_import($1::uuid,$2::uuid,'completed',NULL,'[]'::jsonb,true,NULL,'old.se')`,
      [companyId, oldImport],
    )

    const replacement = await insertImportRow({
      companyId, userId, fiscalPeriodId, status: 'staged', replaces: oldImport,
    })
    await stage(replacement, companyId, [voucher('A', 1, '2025-02-01', [
      { account: '1930', debit: 100, credit: 0 },
      { account: '3001', debit: 0, credit: 90 },
    ])])
    await expect(finalize(companyId, replacement, userId, { replaces_import_id: oldImport }))
      .rejects.toThrow(/SIE_UNBALANCED/)

    const { rows } = await getPool().query(
      `SELECT source_type,status FROM public.journal_entries WHERE sie_import_id=$1`,
      [oldImport],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'posted' })
    const { rows: reversals } = await getPool().query(
      `SELECT id FROM public.sie_import_entry_reversals WHERE sie_import_id=$1`,
      [oldImport],
    )
    expect(reversals).toHaveLength(0)
  })

  it('undo creates storno for only the selected import and never hard-deletes posted rows (I09)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const importA = await insertImportRow({ companyId, userId, fiscalPeriodId, status: 'staged' })
    await stage(importA, companyId, [voucher('A', 1, '2025-02-01', [
      { account: '1930', debit: 100, credit: 0 },
      { account: '3001', debit: 0, credit: 100 },
    ])])
    await finalize(companyId, importA, userId)
    await getPool().query(
      `SELECT public.complete_sie_import($1::uuid,$2::uuid,'completed',NULL,'[]'::jsonb,true,NULL,'a.se')`,
      [companyId, importA],
    )

    const period2 = await insertFiscalPeriod({
      userId, companyId, periodStart: '2024-01-01', periodEnd: '2024-12-31', name: '2024',
    })
    const importB = await insertImportRow({ companyId, userId, fiscalPeriodId: period2, status: 'staged' })
    await stage(importB, companyId, [voucher('B', 1, '2024-02-01', [
      { account: '1930', debit: 70, credit: 0 },
      { account: '3001', debit: 0, credit: 70 },
    ])])
    await finalize(companyId, importB, userId)
    await getPool().query(
      `SELECT public.complete_sie_import($1::uuid,$2::uuid,'completed',NULL,'[]'::jsonb,true,NULL,'b.se')`,
      [companyId, importB],
    )

    const { rows: undo } = await getPool().query(
      `SELECT public.undo_sie_import_internal($1::uuid,$2::uuid,$3::uuid) AS reversed`,
      [companyId, importA, userId],
    )
    expect(undo[0].reversed).toBe(1)

    const { rows: aRows } = await getPool().query(
      `SELECT source_type,status FROM public.journal_entries WHERE sie_import_id=$1`, [importA],
    )
    expect(aRows).toHaveLength(2)
    expect(aRows.some((row) => row.source_type !== 'storno' && row.status === 'reversed')).toBe(true)
    expect(aRows.some((row) => row.source_type === 'storno' && row.status === 'posted')).toBe(true)

    const { rows: bRows } = await getPool().query(
      `SELECT source_type,status FROM public.journal_entries WHERE sie_import_id=$1`, [importB],
    )
    expect(bRows).toHaveLength(1)
    expect(bRows[0].status).toBe('posted')
  })
})

describe('DB-level posted-entry guards (I03)', () => {
  it('a direct INSERT of a posted entry without lines fails at commit', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status, committed_at)
         VALUES ($1, $2, $3, $4, 700, 'A', '2025-06-01', 'Empty posted', 'import', 'posted', now())`,
        [randomUUID(), userId, companyId, fiscalPeriodId],
      )
      await expect(client.query('COMMIT')).rejects.toThrow(/zero total|not balanced/)
      await client.query('ROLLBACK').catch(() => {})
    } finally {
      client.release()
    }
  })

  it('a direct INSERT of an UNBALANCED posted entry fails at commit', async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      const id = randomUUID()
      await client.query(
        `INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status, committed_at)
         VALUES ($1, $2, $3, $4, 701, 'A', '2025-06-01', 'Unbalanced posted', 'import', 'posted', now())`,
        [id, userId, companyId, fiscalPeriodId],
      )
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, '1930', 100, 0), ($1, '3001', 0, 90)`,
        [id],
      )
      await expect(client.query('COMMIT')).rejects.toThrow(/not balanced/)
      await client.query('ROLLBACK').catch(() => {})
    } finally {
      client.release()
    }
  })
})

describe('complete_sie_import (controlled finalization, I17/I18)', () => {
  it("refuses 'completed' without a successful archive", async () => {
    const { userId, companyId, fiscalPeriodId } = await seed()
    const importId = await insertImportRow({ companyId, userId, fiscalPeriodId, status: 'importing' })

    await expect(
      getPool().query(
        `SELECT public.complete_sie_import($1::uuid, $2::uuid, 'completed', NULL, '[]'::jsonb, false, 'archive down', NULL)`,
        [companyId, importId],
      ),
    ).rejects.toThrow(/SIE_ARCHIVE_REQUIRED/)

    // 'partial' with the archive error is the correct fallback.
    await getPool().query(
      `SELECT public.complete_sie_import($1::uuid, $2::uuid, 'partial', NULL, '[]'::jsonb, false, 'archive down', NULL)`,
      [companyId, importId],
    )
    const { rows } = await getPool().query(
      `SELECT status, archive_error FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(rows[0].status).toBe('partial')
    expect(rows[0].archive_error).toBe('archive down')
  })
})
