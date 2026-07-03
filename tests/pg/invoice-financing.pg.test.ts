import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260712120000_invoice_financing:
 *   - RLS: applications/offers/events/settlements are company-scoped.
 *   - Append-only invoice_financing_events (UPDATE blocked by trigger).
 *   - One live application per invoice (partial unique index) — terminal
 *     states free the slot.
 *   - Providers registry is readable by any authenticated user and seeds
 *     the sandbox provider.
 */

async function seedInvoice(params: { userId: string; companyId: string }): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, org_number)
     VALUES ($1, $2, $3, 'Finans Kund AB', 'swedish_business', '5566778899')`,
    [customerId, params.userId, params.companyId],
  )
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-07-01', '2026-07-31', 'SEK',
             10000, 2500, 12500, 'standard_25', 25, 'sent', 0, 12500)`,
    [id, params.userId, params.companyId, customerId, `F-${id.slice(0, 8)}`],
  )
  return id
}

async function insertApplication(params: {
  companyId: string
  invoiceId: string
  userId: string
  status?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoice_financing_applications
       (id, company_id, invoice_id, provider_slug, status, recourse, requested_amount, currency, created_by)
     VALUES ($1, $2, $3, 'sandbox', $4, false, 12500, 'SEK', $5)`,
    [id, params.companyId, params.invoiceId, params.status ?? 'submitted', params.userId],
  )
  return id
}

describe('invoice_financing_providers seed', () => {
  it('sandbox provider is seeded and active', async () => {
    const { rows } = await getPool().query(
      `SELECT slug, kind, status FROM public.invoice_financing_providers WHERE slug = 'sandbox'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('sandbox')
    expect(rows[0].status).toBe('active')
  })
})

describe('invoice_financing_applications RLS + unique live application', () => {
  it('members read only their own company applications', async () => {
    const userA = await insertAuthUser()
    const userB = await insertAuthUser()
    const companyA = await insertCompany({ createdBy: userA })
    const companyB = await insertCompany({ createdBy: userB })
    await insertCompanyMember({ companyId: companyA, userId: userA, role: 'owner' })
    await insertCompanyMember({ companyId: companyB, userId: userB, role: 'owner' })

    const invoiceA = await seedInvoice({ userId: userA, companyId: companyA })
    const invoiceB = await seedInvoice({ userId: userB, companyId: companyB })
    const appA = await insertApplication({ companyId: companyA, invoiceId: invoiceA, userId: userA })
    await insertApplication({ companyId: companyB, invoiceId: invoiceB, userId: userB })

    await withUserContext(userA, async (client) => {
      const { rows } = await client.query(
        `SELECT id, company_id FROM public.invoice_financing_applications`,
      )
      expect(rows.some((r) => r.id === appA)).toBe(true)
      expect(rows.every((r) => r.company_id === companyA)).toBe(true)
    })
  })

  it('blocks a second live application per invoice; terminal frees the slot', async () => {
    const user = await insertAuthUser()
    const company = await insertCompany({ createdBy: user })
    await insertCompanyMember({ companyId: company, userId: user, role: 'owner' })
    const invoice = await seedInvoice({ userId: user, companyId: company })

    const first = await insertApplication({ companyId: company, invoiceId: invoice, userId: user })

    await expect(
      insertApplication({ companyId: company, invoiceId: invoice, userId: user }),
    ).rejects.toThrow(/duplicate key/)

    // Cancel the first → the slot is free again.
    await getPool().query(
      `UPDATE public.invoice_financing_applications SET status = 'cancelled' WHERE id = $1`,
      [first],
    )
    await expect(
      insertApplication({ companyId: company, invoiceId: invoice, userId: user }),
    ).resolves.toBeTruthy()
  })
})

describe('invoice_financing_events append-only', () => {
  it('records events but blocks UPDATE', async () => {
    const user = await insertAuthUser()
    const company = await insertCompany({ createdBy: user })
    await insertCompanyMember({ companyId: company, userId: user, role: 'owner' })
    const invoice = await seedInvoice({ userId: user, companyId: company })
    const app = await insertApplication({ companyId: company, invoiceId: invoice, userId: user })

    const eventId = randomUUID()
    await getPool().query(
      `INSERT INTO public.invoice_financing_events
         (id, company_id, application_id, event_type, status_from, status_to)
       VALUES ($1, $2, $3, 'application_submitted', NULL, 'submitted')`,
      [eventId, company, app],
    )

    await expect(
      getPool().query(
        `UPDATE public.invoice_financing_events SET event_type = 'tampered' WHERE id = $1`,
        [eventId],
      ),
    ).rejects.toThrow()
  })
})

describe('invoice_financing_offers + settlements RLS', () => {
  it('offers and settlements are invisible across companies', async () => {
    const userA = await insertAuthUser()
    const userB = await insertAuthUser()
    const companyA = await insertCompany({ createdBy: userA })
    const companyB = await insertCompany({ createdBy: userB })
    await insertCompanyMember({ companyId: companyA, userId: userA, role: 'owner' })
    await insertCompanyMember({ companyId: companyB, userId: userB, role: 'owner' })

    const invoiceB = await seedInvoice({ userId: userB, companyId: companyB })
    const appB = await insertApplication({ companyId: companyB, invoiceId: invoiceB, userId: userB })

    await getPool().query(
      `INSERT INTO public.invoice_financing_offers
         (company_id, application_id, offered_amount, fee_percent, fee_amount, payout_amount, status)
       VALUES ($1, $2, 12500, 3, 375, 12125, 'open')`,
      [companyB, appB],
    )
    await getPool().query(
      `INSERT INTO public.invoice_financing_settlements
         (company_id, application_id, payout_amount, fee_amount, recourse)
       VALUES ($1, $2, 12125, 375, false)`,
      [companyB, appB],
    )

    await withUserContext(userA, async (client) => {
      const offers = await client.query(`SELECT id FROM public.invoice_financing_offers`)
      const settlements = await client.query(`SELECT id FROM public.invoice_financing_settlements`)
      expect(offers.rows).toHaveLength(0)
      expect(settlements.rows).toHaveLength(0)
    })
  })
})
