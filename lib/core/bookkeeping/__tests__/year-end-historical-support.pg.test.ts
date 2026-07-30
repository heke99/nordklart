import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

async function seed() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await getPool().query(
    `UPDATE public.companies SET org_number = '5594167149' WHERE id = $1`,
    [companyId],
  )
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    name: '2025',
  })
  return { userId, companyId, fiscalPeriodId }
}

async function postReceivable(
  userId: string,
  companyId: string,
  fiscalPeriodId: string,
): Promise<void> {
  const entryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number,
        voucher_series, entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', '2025-06-01',
             'Historisk kundfordran', 'import', 'draft')`,
    [entryId, userId, companyId, fiscalPeriodId],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1510', 11250, 0), ($1, '3001', 0, 11250)`,
    [entryId],
  )
  await getPool().query(
    `SELECT public.commit_journal_entry($1::uuid, $2::uuid)`,
    [companyId, entryId],
  )
}

describe('historical support ledgers', () => {
  it('rejects direct authenticated writes through the service-only RPC boundary', async () => {
    const seeded = await seed()
    await expect(
      withUserContext(seeded.userId, (client) =>
        client.query(
          `SELECT public.record_migrated_open_item(
             'ar', $1::uuid, $2::uuid, $3::uuid, '{}'::jsonb, $4
           )`,
          [
            seeded.companyId,
            seeded.fiscalPeriodId,
            seeded.userId,
            `denied-${randomUUID()}`,
          ],
        ),
      ),
    ).rejects.toThrow(/HISTORICAL_OPEN_ITEM_SERVICE_ONLY/i)

    await expect(
      withUserContext(seeded.userId, (client) =>
        client.query(
          `SELECT public.accept_year_end_historical_workpapers(
             $1::uuid, $2::uuid, $3::uuid, $4::uuid[], $5, NULL
           )`,
          [
            seeded.companyId,
            seeded.fiscalPeriodId,
            seeded.userId,
            [randomUUID()],
            'Otillåtet direktanrop.',
          ],
        ),
      ),
    ).rejects.toThrow(/YEAR_END_WORKPAPER_ACCEPT_SERVICE_ONLY/i)
  })

  it('treats staged SIE as unfinished in the same blocker function used by close', async () => {
    const seeded = await seed()
    await getPool().query(
      `INSERT INTO public.sie_imports
         (id, user_id, company_id, filename, file_hash, sie_type,
          fiscal_year_start, fiscal_year_end, status, fiscal_period_id, org_number)
       VALUES ($1, $2, $3, 'staged.se', $4, 4, '2025-01-01',
               '2025-12-31', 'staged', $5, '5594167149')`,
      [
        randomUUID(),
        seeded.userId,
        seeded.companyId,
        randomUUID(),
        seeded.fiscalPeriodId,
      ],
    )

    const { rows } = await getPool().query<{ code: string }>(
      `SELECT code FROM public.year_end_db_blockers($1::uuid, $2::uuid)`,
      [seeded.companyId, seeded.fiscalPeriodId],
    )
    expect(rows.map((row) => row.code)).toContain('unfinished_sie_imports')
  })

  it('reconstructs AR support without creating a journal entry and requires evidence', async () => {
    const seeded = await seed()
    await postReceivable(seeded.userId, seeded.companyId, seeded.fiscalPeriodId)
    const before = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries WHERE company_id = $1`,
      [seeded.companyId],
    )

    const key = `item-${randomUUID()}`
    const { rows: created } = await getPool().query<{ result: { id: string } }>(
      `SELECT public.record_migrated_open_item(
         'ar', $1::uuid, $2::uuid, $3::uuid,
         $4::jsonb, $5
       ) AS result`,
      [
        seeded.companyId,
        seeded.fiscalPeriodId,
        seeded.userId,
        JSON.stringify({
          counterparty_name: 'Historisk kund',
          invoice_number: 'H-100',
          invoice_date: '2025-11-30',
          due_date: '2025-12-30',
          currency: 'SEK',
          original_amount_currency: 11250,
          paid_amount_currency: 0,
          remaining_amount_currency: 11250,
          control_account: '1510',
        }),
        key,
      ],
    )
    const after = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries WHERE company_id = $1`,
      [seeded.companyId],
    )
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)

    const withoutEvidence = await getPool().query<{
      is_reconciled: boolean
      missing_evidence_count: number
    }>(
      `SELECT is_reconciled, missing_evidence_count
         FROM public.customer_receivables_reconciliation_at(
           $1::uuid, $2::uuid, DATE '2025-12-31'
         )`,
      [seeded.companyId, seeded.fiscalPeriodId],
    )
    expect(withoutEvidence.rows[0]).toMatchObject({
      is_reconciled: false,
      missing_evidence_count: 1,
    })

    const documentId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id, user_id, company_id, storage_path, file_name, file_size_bytes,
          mime_type, sha256_hash, uploaded_by, upload_source)
       VALUES ($1, $2, $3, $4, 'historisk-faktura.pdf', 100,
               'application/pdf', $5, $2, 'file_upload')`,
      [
        documentId,
        seeded.userId,
        seeded.companyId,
        `documents/${seeded.userId}/${documentId}.pdf`,
        'a'.repeat(64),
      ],
    )
    await getPool().query(
      `SELECT public.attach_migrated_open_item_document(
         'ar', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid
       )`,
      [
        seeded.companyId,
        seeded.fiscalPeriodId,
        created[0]?.result.id,
        documentId,
        seeded.userId,
      ],
    )

    const withEvidence = await getPool().query<{
      is_reconciled: boolean
      difference: string
    }>(
      `SELECT is_reconciled, difference::text
         FROM public.customer_receivables_reconciliation_at(
           $1::uuid, $2::uuid, DATE '2025-12-31'
         )`,
      [seeded.companyId, seeded.fiscalPeriodId],
    )
    expect(withEvidence.rows[0]).toMatchObject({
      is_reconciled: true,
      difference: '0.00',
    })
  })

  it('stores an approved structured disposition without booking a dividend debt', async () => {
    const seeded = await seed()
    const before = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries WHERE company_id = $1`,
      [seeded.companyId],
    )
    const { rows } = await getPool().query<{
      result: { journal_entry_created: boolean; proposed_dividend: number }
    }>(
      `SELECT public.record_year_end_profit_disposition(
         $1::uuid, $2::uuid, $3::uuid, $4::jsonb
       ) AS result`,
      [
        seeded.companyId,
        seeded.fiscalPeriodId,
        seeded.userId,
        JSON.stringify({
          current_year_result: 13_595.31,
          free_equity: 13_595.31,
          proposed_dividend: 0,
          carried_forward: 13_595.31,
        }),
      ],
    )
    const after = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries WHERE company_id = $1`,
      [seeded.companyId],
    )
    expect(rows[0]?.result).toMatchObject({
      journal_entry_created: false,
      proposed_dividend: 0,
    })
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)
  })

  it('creates an SIE workpaper instead of a false zero subledger difference', async () => {
    const seeded = await seed()
    await postReceivable(seeded.userId, seeded.companyId, seeded.fiscalPeriodId)
    const importId = randomUUID()
    await getPool().query(
      `INSERT INTO public.sie_imports
         (id, user_id, company_id, filename, file_hash, sie_type,
          fiscal_year_start, fiscal_year_end, status, fiscal_period_id,
          org_number, imported_at)
       VALUES ($1, $2, $3, 'historik.se', $4, 4, '2025-01-01',
               '2025-12-31', 'completed', $5, '5594167149', now())`,
      [
        importId,
        seeded.userId,
        seeded.companyId,
        randomUUID(),
        seeded.fiscalPeriodId,
      ],
    )
    await getPool().query(
      `SELECT public.refresh_year_end_historical_workpapers(
         $1::uuid, $2::uuid, $3::uuid
       )`,
      [seeded.companyId, seeded.fiscalPeriodId, importId],
    )

    const { rows: workpapers } = await getPool().query<{
      id: string
      status: string
      imported_amount: string
    }>(
      `SELECT id, status, imported_amount::text
       FROM public.year_end_historical_workpapers
       WHERE company_id = $1
         AND fiscal_period_id = $2
         AND category = 'customer_receivables'`,
      [seeded.companyId, seeded.fiscalPeriodId],
    )
    expect(workpapers[0]).toMatchObject({
      status: 'imported_from_sie',
      imported_amount: '11250.00',
    })

    const { rows: controls } = await getPool().query<{
      status: string
      supporting_register_amount: string | null
      difference: string | null
    }>(
      `SELECT
         status,
         supporting_register_amount::text,
         difference::text
       FROM public.year_end_control_status($1::uuid, $2::uuid)
       WHERE control_code = 'customer_receivables_reconciliation'`,
      [seeded.companyId, seeded.fiscalPeriodId],
    )
    expect(controls[0]).toMatchObject({
      status: 'imported_from_sie',
      supporting_register_amount: null,
      difference: null,
    })
  })

  it('accepts an imported SIE balance without creating a journal entry', async () => {
    const seeded = await seed()
    await postReceivable(seeded.userId, seeded.companyId, seeded.fiscalPeriodId)
    const importId = randomUUID()
    await getPool().query(
      `INSERT INTO public.sie_imports
         (id, user_id, company_id, filename, file_hash, sie_type,
          fiscal_year_start, fiscal_year_end, status, fiscal_period_id,
          org_number, imported_at)
       VALUES ($1, $2, $3, 'historik-accept.se', $4, 4, '2025-01-01',
               '2025-12-31', 'completed', $5, '5594167149', now())`,
      [
        importId,
        seeded.userId,
        seeded.companyId,
        randomUUID(),
        seeded.fiscalPeriodId,
      ],
    )
    await getPool().query(
      `SELECT public.refresh_year_end_historical_workpapers(
         $1::uuid, $2::uuid, $3::uuid
       )`,
      [seeded.companyId, seeded.fiscalPeriodId, importId],
    )
    const workpaper = await getPool().query<{ id: string }>(
      `SELECT id
       FROM public.year_end_historical_workpapers
       WHERE company_id = $1
         AND fiscal_period_id = $2
         AND category = 'customer_receivables'`,
      [seeded.companyId, seeded.fiscalPeriodId],
    )
    const before = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.journal_entries
       WHERE company_id = $1`,
      [seeded.companyId],
    )

    const { rows } = await getPool().query<{
      result: { journal_entry_created: boolean }
    }>(
      `SELECT public.accept_year_end_historical_workpapers(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid[], $5, NULL
       ) AS result`,
      [
        seeded.companyId,
        seeded.fiscalPeriodId,
        seeded.userId,
        [workpaper.rows[0]!.id],
        'SIE-saldot har granskats.',
      ],
    )
    const after = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM public.journal_entries
       WHERE company_id = $1`,
      [seeded.companyId],
    )
    expect(rows[0]?.result.journal_entry_created).toBe(false)
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count)

    const control = await getPool().query<{ status: string; is_blocking: boolean }>(
      `SELECT status, is_blocking
       FROM public.year_end_control_status($1::uuid, $2::uuid)
       WHERE control_code = 'customer_receivables_reconciliation'`,
      [seeded.companyId, seeded.fiscalPeriodId],
    )
    expect(control.rows[0]).toMatchObject({
      status: 'sie_balance_accepted',
      is_blocking: false,
    })
  })
})
