import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

async function insertImport(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  status?: 'pending' | 'completed' | 'failed' | 'replaced'
  fileHash?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type,
        fiscal_year_start, fiscal_year_end, status, fiscal_period_id, imported_at)
     VALUES ($1,$2,$3,'test.se',$4,4,'2026-01-01','2026-12-31',$5,$6,
             CASE WHEN $5 = 'completed' THEN now() ELSE NULL END)`,
    [id, params.userId, params.companyId, params.fileHash ?? randomUUID(), params.status ?? 'completed', params.fiscalPeriodId],
  )
  return id
}

async function insertTaggedPostedEntry(params: {
  companyId: string
  userId: string
  fiscalPeriodId: string
  importId: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `WITH e AS (
       INSERT INTO public.journal_entries
         (id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,
          entry_date,description,source_type,status,sie_import_id,external_reference)
       VALUES ($1,$2,$3,$4,1,'A','2026-06-01','Imported voucher','import','posted',$5,'A:1:2026-06-01')
       RETURNING id
     )
     INSERT INTO public.journal_entry_lines
       (journal_entry_id,account_number,debit_amount,credit_amount,line_description)
     SELECT id,'1930',100,0,'Bank' FROM e
     UNION ALL
     SELECT id,'3001',0,100,'Revenue' FROM e`,
    [id, params.userId, params.companyId, params.fiscalPeriodId, params.importId],
  )
  await getPool().query(
    `INSERT INTO public.voucher_sequences
       (company_id,user_id,fiscal_period_id,voucher_series,last_number)
     VALUES ($1,$2,$3,'A',1)
     ON CONFLICT (company_id,fiscal_period_id,voucher_series)
     DO UPDATE SET last_number = GREATEST(public.voucher_sequences.last_number, 1)`,
    [params.companyId, params.userId, params.fiscalPeriodId],
  )
  return id
}

describe('SIE replacement and undo preserve räkenskapsinformation', () => {
  it('keeps the active-hash uniqueness rule', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const hash = `hash-${randomUUID()}`
    await insertImport({ companyId, userId, fiscalPeriodId, fileHash: hash })

    await expect(insertImport({
      companyId,
      userId,
      fiscalPeriodId,
      fileHash: hash,
      status: 'pending',
    })).rejects.toThrow(/sie_imports_company_id_file_hash_active_idx/)
  })

  it('disables direct replace without a corrected staged file', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertImport({ companyId, userId, fiscalPeriodId })

    await expect(
      getPool().query(
        `SELECT public.replace_sie_import($1::uuid,$2::uuid)`,
        [companyId, importId],
      ),
    ).rejects.toThrow(/SIE_REPLACE_FILE_REQUIRED/)
  })

  it('undo creates an exact storno and preserves original lines and attachments', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertImport({ companyId, userId, fiscalPeriodId })
    const originalId = await insertTaggedPostedEntry({ companyId, userId, fiscalPeriodId, importId })
    const documentId = randomUUID()
    await getPool().query(
      `INSERT INTO public.document_attachments
         (id,user_id,company_id,storage_path,file_name,sha256_hash,journal_entry_id,upload_source)
       VALUES ($1,$2,$3,$4,'voucher.pdf',$5,$6,'file_upload')`,
      [documentId, userId, companyId, `test/${documentId}.pdf`, `sha256-${documentId}`, originalId],
    )

    const { rows } = await getPool().query<{ reversed: number }>(
      `SELECT public.undo_sie_import_internal($1::uuid,$2::uuid,$3::uuid) AS reversed`,
      [companyId, importId, userId],
    )
    expect(rows[0]?.reversed).toBe(1)

    const entries = await getPool().query<{
      id: string
      source_type: string
      status: string
      reverses_id: string | null
      reversed_by_id: string | null
    }>(
      `SELECT id,source_type,status,reverses_id,reversed_by_id
       FROM public.journal_entries
       WHERE sie_import_id = $1
       ORDER BY source_type`,
      [importId],
    )
    expect(entries.rows).toHaveLength(2)
    const original = entries.rows.find((row) => row.id === originalId)
    const reversal = entries.rows.find((row) => row.source_type === 'storno')
    expect(original?.status).toBe('reversed')
    expect(reversal?.status).toBe('posted')
    expect(original?.reversed_by_id).toBe(reversal?.id)
    expect(reversal?.reverses_id).toBe(originalId)

    const lines = await getPool().query<{
      entry_id: string
      account_number: string
      debit_amount: string
      credit_amount: string
    }>(
      `SELECT journal_entry_id AS entry_id,account_number,
              debit_amount::text,credit_amount::text
       FROM public.journal_entry_lines
       WHERE journal_entry_id IN ($1,$2)
       ORDER BY journal_entry_id,account_number`,
      [originalId, reversal?.id],
    )
    expect(lines.rows.filter((row) => row.entry_id === originalId)).toHaveLength(2)
    const reversal1930 = lines.rows.find((row) => row.entry_id === reversal?.id && row.account_number === '1930')
    expect(reversal1930?.debit_amount).toBe('0')
    expect(reversal1930?.credit_amount).toBe('100')

    const attachment = await getPool().query<{ journal_entry_id: string | null }>(
      `SELECT journal_entry_id FROM public.document_attachments WHERE id = $1`,
      [documentId],
    )
    expect(attachment.rows[0]?.journal_entry_id).toBe(originalId)

    const sequence = await getPool().query<{ last_number: number }>(
      `SELECT last_number FROM public.voucher_sequences
       WHERE company_id=$1 AND fiscal_period_id=$2 AND voucher_series='A'`,
      [companyId, fiscalPeriodId],
    )
    expect(sequence.rows[0]?.last_number).toBe(2)
  })

  it('fails closed for legacy imports without exact provenance', async () => {
    const { companyId, userId, fiscalPeriodId } = await seedCompany()
    const importId = await insertImport({ companyId, userId, fiscalPeriodId })

    await expect(
      getPool().query(
        `SELECT public.undo_sie_import_internal($1::uuid,$2::uuid,$3::uuid)`,
        [companyId, importId, userId],
      ),
    ).rejects.toThrow(/SIE_LEGACY_PROVENANCE_REQUIRED/)
  })
})
