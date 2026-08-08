import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertBalancedLines, insertDraftJournalEntry, seedCompany } from '@/tests/pg/fixtures'

describe('financial atomicity database contract', () => {
  it('blocks posted -> cancelled and keeps the original voucher posted', async () => {
    const seeded = await seedCompany()
    const entryId = await insertDraftJournalEntry(seeded)
    await insertBalancedLines(entryId, 1000)
    await getPool().query(
      `SELECT public.commit_journal_entry($1::uuid, $2::uuid, 'migration', NULL, 'user', NULL)`,
      [seeded.companyId, entryId],
    )

    await expect(
      getPool().query(`UPDATE public.journal_entries SET status = 'cancelled' WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/POSTED_ENTRY_REQUIRES_REVERSAL|linked reversal/i)

    const { rows } = await getPool().query<{ status: string; voucher_number: number }>(
      `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(rows[0]?.status).toBe('posted')
    expect(rows[0]?.voucher_number).toBeGreaterThan(0)
  })

  it('exposes settlement functions only to service_role and pins search_path', async () => {
    const { rows } = await getPool().query<{
      proname: string
      proconfig: string[] | null
      authenticated_execute: boolean
      service_execute: boolean
    }>(`
      SELECT
        p.proname,
        p.proconfig,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('settle_customer_invoice', 'settle_supplier_invoice', 'stripe_apply_one_time_purchase_event')
      ORDER BY p.proname
    `)

    expect(rows.map((row) => row.proname)).toEqual([
      'settle_customer_invoice',
      'settle_supplier_invoice',
      'stripe_apply_one_time_purchase_event',
    ])
    for (const row of rows) {
      expect(row.authenticated_execute).toBe(false)
      expect(row.service_execute).toBe(true)
      expect(row.proconfig).toContain('search_path=public, pg_temp')
    }
  })

  it('does not persist an idempotency row when settlement validation raises', async () => {
    const seeded = await seedCompany()
    const idempotencyKey = `pg-${randomUUID()}`
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
      await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`)
      await expect(client.query(
        `SELECT public.settle_customer_invoice(
          $1::uuid, $2::uuid, $3::uuid, DATE '2026-05-12', 100::numeric,
          'SEK', 0::numeric, NULL::uuid, $4, repeat('a', 64), 'req_pg', NULL, NULL,
          $5::uuid, 100::numeric
        )`,
        [seeded.companyId, randomUUID(), seeded.userId, idempotencyKey, randomUUID()],
      )).rejects.toThrow(/Invoice not found/i)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }

    const { rows } = await getPool().query(
      `SELECT id FROM public.financial_operation_idempotency WHERE company_id = $1 AND idempotency_key = $2`,
      [seeded.companyId, idempotencyKey],
    )
    expect(rows).toEqual([])
  })
})
