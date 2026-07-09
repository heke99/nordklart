/**
 * pg-real coverage for migration 20260715170000 (RLS write-capability):
 *
 *  - Viewers can READ but not WRITE invoices, journal drafts and recurring
 *    schedules directly against the database.
 *  - Owners (write-capable) can write.
 *  - skatteverket_tokens is service-role only; the metadata view exposes
 *    connection state per tenant without token material.
 *  - skatteverket_api_requests is read-only for members.
 *  - oauth_used_codes is inaccessible to authenticated users.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember, insertFiscalPeriod } from './fixtures'

describe('RLS write capability', () => {
  let ownerId: string
  let viewerId: string
  let outsiderId: string
  let companyId: string
  let otherCompanyId: string

  beforeAll(async () => {
    ownerId = await insertAuthUser()
    viewerId = await insertAuthUser()
    outsiderId = await insertAuthUser()
    companyId = await insertCompany({ createdBy: ownerId })
    await insertCompanyMember({ companyId, userId: ownerId, role: 'owner' })
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })
    await insertFiscalPeriod({ userId: ownerId, companyId })
    otherCompanyId = await insertCompany({ createdBy: outsiderId })
    await insertCompanyMember({ companyId: otherCompanyId, userId: outsiderId, role: 'owner' })
  })

  it('viewer can read but not insert invoices', async () => {
    const invoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoices (id, user_id, company_id, invoice_date, due_date, subtotal, vat_amount, total, status)
       VALUES ($1, $2, $3, '2026-05-01', '2026-05-31', 100, 25, 125, 'draft')`,
      [invoiceId, ownerId, companyId],
    )

    const readable = await withUserContext(viewerId, async (client) => {
      const { rows } = await client.query(`SELECT id FROM public.invoices WHERE id = $1`, [invoiceId])
      return rows.length
    })
    expect(readable).toBe(1)

    await withUserContext(viewerId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.invoices (user_id, company_id, invoice_date, due_date, subtotal, vat_amount, total, status)
           VALUES ($1, $2, '2026-05-01', '2026-05-31', 100, 25, 125, 'draft')`,
          [viewerId, companyId],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })

    // Viewer UPDATE is filtered by the policy: zero rows affected.
    const updated = await withUserContext(viewerId, async (client) => {
      const result = await client.query(`UPDATE public.invoices SET notes = 'x' WHERE id = $1`, [invoiceId])
      return result.rowCount
    })
    expect(updated).toBe(0)
  })

  it('owner can insert and update invoices', async () => {
    await withUserContext(ownerId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.invoices (user_id, company_id, invoice_date, due_date, subtotal, vat_amount, total, status)
         VALUES ($1, $2, '2026-05-02', '2026-06-01', 200, 50, 250, 'draft')
         RETURNING id`,
        [ownerId, companyId],
      )
      expect(rows).toHaveLength(1)
      const result = await client.query(`UPDATE public.invoices SET notes = 'ok' WHERE id = $1`, [rows[0].id])
      expect(result.rowCount).toBe(1)
    })
  })

  it('viewer cannot create journal drafts or draft lines', async () => {
    await withUserContext(viewerId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.journal_entries (user_id, company_id, entry_date, description, status)
           VALUES ($1, $2, '2026-05-01', 'Viewer draft', 'draft')`,
          [viewerId, companyId],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('viewer cannot create recurring invoice schedules', async () => {
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Kund AB')`,
      [customerId, ownerId, companyId],
    )
    await withUserContext(viewerId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.recurring_invoice_schedules (company_id, user_id, customer_id, name, day_of_month, next_run_date)
           VALUES ($1, $2, $3, 'Viewer schedule', 15, '2026-08-15')`,
          [companyId, viewerId, customerId],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
    await withUserContext(ownerId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO public.recurring_invoice_schedules (company_id, user_id, customer_id, name, day_of_month, next_run_date)
         VALUES ($1, $2, $3, 'Owner schedule', 15, '2026-08-15') RETURNING id`,
        [companyId, ownerId, customerId],
      )
      expect(rows).toHaveLength(1)
    })
  })

  it('skatteverket_tokens is unreadable for members; the view exposes metadata per tenant', async () => {
    await getPool().query(
      `INSERT INTO public.skatteverket_tokens (user_id, company_id, access_token, expires_at)
       VALUES ($1, $2, 'encrypted-token-material', now() + interval '1 hour')`,
      [ownerId, companyId],
    )

    // Direct table read: RLS with zero policies → empty for everyone.
    for (const userId of [ownerId, viewerId, outsiderId]) {
      const rows = await withUserContext(userId, async (client) => {
        const result = await client.query(`SELECT access_token FROM public.skatteverket_tokens`)
        return result.rows
      })
      expect(rows).toHaveLength(0)
    }

    // View: members see their company's connection metadata, outsiders none.
    const memberView = await withUserContext(viewerId, async (client) => {
      const { rows } = await client.query(
        `SELECT company_id, expires_at FROM public.skatteverket_connections_v WHERE company_id = $1`,
        [companyId],
      )
      return rows
    })
    expect(memberView).toHaveLength(1)

    const outsiderView = await withUserContext(outsiderId, async (client) => {
      const { rows } = await client.query(
        `SELECT company_id FROM public.skatteverket_connections_v WHERE company_id = $1`,
        [companyId],
      )
      return rows
    })
    expect(outsiderView).toHaveLength(0)
  })

  it('members cannot write to the skatteverket API audit log', async () => {
    await withUserContext(ownerId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.skatteverket_api_requests (company_id, user_id, service, operation, auth_flow, correlation_id, method, status)
           VALUES ($1, $2, 'momsdeklaration', 'forged', 'ccg_sysorg', $3, 'POST', 'succeeded')`,
          [companyId, ownerId, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('oauth_used_codes is inaccessible to authenticated users', async () => {
    await getPool().query(
      `INSERT INTO public.oauth_used_codes (code_hash) VALUES ($1)`,
      [randomUUID().replace(/-/g, '')],
    )
    await withUserContext(ownerId, async (client) => {
      const { rows } = await client.query(`SELECT * FROM public.oauth_used_codes`)
      expect(rows).toHaveLength(0)
      await expect(
        client.query(`INSERT INTO public.oauth_used_codes (code_hash) VALUES ('forged-hash')`),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })
})
