import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertTransaction,
} from '@/tests/pg/fixtures'

// One viewer policy (revision item K08 + §10.10 behörighet):
// viewers are READ-ONLY on bank data at the DATABASE level. Even a direct
// PostgREST/SQL write with a manipulated company_id must fail RLS.

async function seedWithViewer(): Promise<{
  ownerId: string
  viewerId: string
  outsiderId: string
  companyId: string
}> {
  const ownerId = await insertAuthUser()
  const viewerId = await insertAuthUser()
  const outsiderId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: ownerId })
  await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
  await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
  return { ownerId, viewerId, outsiderId, companyId }
}

describe('viewer write-hardening on bank tables (K08)', () => {
  it('viewer can SELECT but cannot INSERT into transactions', async () => {
    const { ownerId, viewerId, companyId } = await seedWithViewer()
    await insertTransaction({ companyId, userId: ownerId, externalId: `t-${randomUUID()}` })

    await withUserContext(viewerId, async (client) => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM public.transactions WHERE company_id = $1`,
        [companyId],
      )
      expect(rows[0].n).toBe(1)

      await expect(
        client.query(
          `INSERT INTO public.transactions
             (company_id, user_id, currency, amount, date, description, category)
           VALUES ($1, $2, 'SEK', -100, '2026-06-01', 'Viewer insert', 'uncategorized')`,
          [companyId, viewerId],
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })

  it('viewer cannot UPDATE or DELETE transactions', async () => {
    const { ownerId, viewerId, companyId } = await seedWithViewer()
    const txId = await insertTransaction({
      companyId,
      userId: ownerId,
      externalId: `t-${randomUUID()}`,
    })

    await withUserContext(viewerId, async (client) => {
      // RLS UPDATE policies filter rows out instead of raising — zero rows
      // touched IS the enforcement.
      const updateResult = await client.query(
        `UPDATE public.transactions SET description = 'hacked' WHERE id = $1 RETURNING id`,
        [txId],
      )
      expect(updateResult.rowCount).toBe(0)

      const deleteResult = await client.query(
        `DELETE FROM public.transactions WHERE id = $1 RETURNING id`,
        [txId],
      )
      expect(deleteResult.rowCount).toBe(0)
    })
  })

  it('owner (member with write capability) CAN insert transactions', async () => {
    const { ownerId, companyId } = await seedWithViewer()
    await withUserContext(ownerId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.transactions
           (company_id, user_id, currency, amount, date, description, category)
         VALUES ($1, $2, 'SEK', -100, '2026-06-01', 'Owner insert', 'uncategorized')
         RETURNING id`,
        [companyId, ownerId],
      )
      expect(rows).toHaveLength(1)
    })
  })

  it('a user without membership sees nothing and cannot write (tenant isolation)', async () => {
    const { ownerId, outsiderId, companyId } = await seedWithViewer()
    await insertTransaction({ companyId, userId: ownerId, externalId: `t-${randomUUID()}` })

    await withUserContext(outsiderId, async (client) => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM public.transactions WHERE company_id = $1`,
        [companyId],
      )
      expect(rows[0].n).toBe(0)

      await expect(
        client.query(
          `INSERT INTO public.transactions
             (company_id, user_id, currency, amount, date, description, category)
           VALUES ($1, $2, 'SEK', -100, '2026-06-01', 'Outsider insert', 'uncategorized')`,
          [companyId, outsiderId],
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })

  it('viewer cannot mutate bookkeeping through the hardened SECURITY DEFINER RPCs', async () => {
    const { ownerId, viewerId, companyId } = await seedWithViewer()

    // Seed a completed import owned by the company.
    const importId = randomUUID()
    await getPool().query(
      `INSERT INTO public.sie_imports
         (id, user_id, company_id, filename, file_hash, sie_type, status)
       VALUES ($1, $2, $3, 'f.se', $4, 4, 'completed')`,
      [importId, ownerId, companyId, randomUUID()],
    )

    // Each rejected query aborts the surrounding transaction, so every RPC
    // gets its own user context.
    await withUserContext(viewerId, async (client) => {
      await expect(
        client.query(`SELECT public.undo_sie_import($1::uuid, $2::uuid)`, [companyId, importId]),
      ).rejects.toThrow(/Only company owners and admins/)
    })
    await withUserContext(viewerId, async (client) => {
      await expect(
        client.query(`SELECT public.replace_sie_import($1::uuid, $2::uuid)`, [
          companyId,
          importId,
        ]),
      ).rejects.toThrow(/Only company owners and admins/)
    })

    // Viewer also cannot run the year-end close.
    await withUserContext(viewerId, async (client) => {
      await expect(
        client.query(
          `SELECT public.execute_year_end_closing(
             $1::uuid, $2::uuid, $3::uuid, 'k', NULL, $4::uuid, 'req-test'
           )`,
          [companyId, randomUUID(), viewerId, randomUUID()],
        ),
      ).rejects.toThrow(/permission denied/i)
    })
  })
})

describe('bank_file_import_rows (K04 row-level status)', () => {
  it('enforces the (import_id, row_key) uniqueness for idempotent retry', async () => {
    const { ownerId, companyId } = await seedWithViewer()
    const importId = randomUUID()
    await getPool().query(
      `INSERT INTO public.bank_file_imports
         (id, user_id, company_id, filename, file_hash, file_format, status)
       VALUES ($1, $2, $3, 'bank.csv', $4, 'generic_csv', 'processing')`,
      [importId, ownerId, companyId, randomUUID()],
    )

    await getPool().query(
      `INSERT INTO public.bank_file_import_rows (import_id, company_id, row_index, row_key, status)
       VALUES ($1, $2, 0, 'row-1', 'imported')`,
      [importId, companyId],
    )
    await expect(
      getPool().query(
        `INSERT INTO public.bank_file_import_rows (import_id, company_id, row_index, row_key, status)
         VALUES ($1, $2, 1, 'row-1', 'pending')`,
        [importId, companyId],
      ),
    ).rejects.toThrow(/duplicate key/)
  })

  it('bank_file_imports.status only accepts the state machine values', async () => {
    const { ownerId, companyId } = await seedWithViewer()
    await expect(
      getPool().query(
        `INSERT INTO public.bank_file_imports
           (user_id, company_id, filename, file_hash, file_format, status)
         VALUES ($1, $2, 'bank.csv', $3, 'generic_csv', 'weird_status')`,
        [ownerId, companyId, randomUUID()],
      ),
    ).rejects.toThrow(/bank_file_imports_status_check/)
  })
})
