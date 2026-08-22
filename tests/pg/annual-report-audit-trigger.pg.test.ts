import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertCompanySettings,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

/**
 * audit_annual_report_document_change is shared by three tables, and only one
 * of them has `created_by` / `revoked_by`.
 *
 * The TG_TABLE_NAME guard around `NEW.created_by` looked sufficient, but
 * PL/pgSQL caches the prepared plan for the whole expression on the FUNCTION,
 * not per row type. Once a backend ran the trigger for
 * annual_report_presentation_reclassifications, the cached plan carried a
 * `created_by` extraction and the next write to either other table on that same
 * connection failed with `record "new" has no field "created_by"` — so
 * årsredovisning signing broke depending on what the pooled connection had
 * touched first, and passed in any test that used one table per connection.
 *
 * This test therefore does the one thing that reproduces it: BOTH tables, in
 * order, ON THE SAME CONNECTION.
 */
describe('shared annual-report audit trigger (pg-real)', () => {
  it('survives a reclassification and a signature request on one connection', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    await insertCompanySettings({ companyId })
    const fiscalPeriodId = await insertFiscalPeriod({
      userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31', name: '2026',
    })

    const client = await getClient()
    try {
      const projectId = randomUUID()
      await client.query(
        `INSERT INTO public.annual_report_projects (id, company_id, fiscal_period_id)
         VALUES ($1, $2, $3)`,
        [projectId, companyId, fiscalPeriodId],
      )

      // 1. The table that HAS created_by — this is what poisons the plan cache.
      await client.query(
        `INSERT INTO public.annual_report_presentation_reclassifications
           (id, project_id, company_id, fiscal_period_id, account_number,
            source_concept, target_concept, original_presentation, target_presentation,
            amount, reason, created_by)
         VALUES ($1, $2, $3, $4, '1510', 'a', 'b', 'c', 'd', 100, 'Omklassificering', $5)`,
        [randomUUID(), projectId, companyId, fiscalPeriodId, userId],
      )

      // 2. A table that does NOT, on the same backend. This used to throw.
      const signatureId = randomUUID()
      await client.query(
        `INSERT INTO public.arsredovisning_signature_requests
           (id, user_id, company_id, fiscal_period_id, role, signer_name, status)
         VALUES ($1, $2, $3, $4, 'styrelseledamot', 'Test Testsson', 'pending')`,
        [signatureId, userId, companyId, fiscalPeriodId],
      )

      // 3. And an UPDATE, which takes the other CASE branch.
      await client.query(
        `UPDATE public.arsredovisning_signature_requests SET signer_name = 'Testa Testsson' WHERE id = $1`,
        [signatureId],
      )

      const { rows } = await client.query<{ event_type: string }>(
        `SELECT event_type FROM public.annual_report_audit_events
          WHERE company_id = $1 ORDER BY created_at`,
        [companyId],
      )
      expect(rows.map((r) => r.event_type)).toContain('arsredovisning_signature_requests_insert')
      expect(rows.map((r) => r.event_type)).toContain('arsredovisning_signature_requests_update')
    } finally {
      client.release()
    }
  })
})
