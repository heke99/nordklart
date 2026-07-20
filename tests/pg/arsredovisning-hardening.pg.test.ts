import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

// Annual report + legal-form hardening (revision items R10, R14, B13).

describe('company_entity_type + mirror sync (B13)', () => {
  it('returns the canonical legal form and keeps the settings mirror in sync', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'aktiebolag' })
    await insertCompanyMember({ companyId, userId, role: 'owner' })

    const pool = getPool()
    const { rows } = await pool.query(`SELECT public.company_entity_type($1::uuid) AS et`, [
      companyId,
    ])
    expect(rows[0].et).toBe('aktiebolag')

    // Create a settings row with a stale mirror, then flip the canonical
    // column — the trigger must sync the mirror.
    await pool.query(
      `INSERT INTO public.company_settings (company_id, user_id, company_name, entity_type)
       VALUES ($1, $2, 'Test AB', 'aktiebolag')`,
      [companyId, userId],
    )
    await pool.query(`UPDATE public.companies SET entity_type = 'enskild_firma' WHERE id = $1`, [
      companyId,
    ])
    const { rows: mirror } = await pool.query(
      `SELECT entity_type FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(mirror[0].entity_type).toBe('enskild_firma')
  })
})

describe('arsredovisning_narrative_confirmations (R10)', () => {
  it('is append-only: members can insert but not update or delete', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })

    let confirmationId: string | null = null
    await withUserContext(userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.arsredovisning_narrative_confirmations
           (company_id, fiscal_period_id, field, confirmed_text, text_version, confirmed_by)
         VALUES ($1, $2, 'important_events', 'Inga väsentliga händelser.', 1, $3)
         RETURNING id`,
        [companyId, fiscalPeriodId, userId],
      )
      confirmationId = rows[0].id

      // No UPDATE policy → zero rows affected.
      const upd = await client.query(
        `UPDATE public.arsredovisning_narrative_confirmations
         SET confirmed_text = 'tampered' WHERE id = $1 RETURNING id`,
        [confirmationId],
      )
      expect(upd.rowCount).toBe(0)

      // No DELETE policy → zero rows affected.
      const del = await client.query(
        `DELETE FROM public.arsredovisning_narrative_confirmations WHERE id = $1 RETURNING id`,
        [confirmationId],
      )
      expect(del.rowCount).toBe(0)
    })
  })

  it('viewer cannot insert confirmations (write capability required)', async () => {
    const ownerId = await insertAuthUser()
    const viewerId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: ownerId })
    await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId: ownerId, companyId })

    await withUserContext(viewerId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.arsredovisning_narrative_confirmations
             (company_id, fiscal_period_id, field, confirmed_text, text_version, confirmed_by)
           VALUES ($1, $2, 'description', 'text', 1, $3)`,
          [companyId, fiscalPeriodId, viewerId],
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })
})

describe('arsredovisning_submissions idempotency (R14)', () => {
  it('blocks two ACTIVE submissions with the same idempotency key', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })

    const insertSubmission = (status: string) =>
      getPool().query(
        `INSERT INTO public.arsredovisning_submissions
           (company_id, user_id, fiscal_period_id, handling_typ, taxonomy_version,
            entry_point, environment, status, payload_hash, idempotency_key)
         VALUES ($1, $2, $3, 'arsredovisning_komplett', '2024-09-12',
                 'ep', 'test', $4, 'hash-x', 'period:hash-x')`,
        [companyId, userId, fiscalPeriodId, status],
      )

    await insertSubmission('uploaded')
    await expect(insertSubmission('uploaded')).rejects.toThrow(/duplicate key/)
    // A non-active retry row (e.g. error) is allowed.
    await insertSubmission('error')
  })
})
