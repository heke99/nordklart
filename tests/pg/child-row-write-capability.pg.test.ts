/**
 * Child rows inherit the parent's write gate.
 *
 * `supplier_invoice_items` and `receipt_line_items` have no `company_id` of
 * their own — they reach tenancy through their parent. The 147-policy sweep in
 * 20260808170000 was built from tables carrying `company_id`, so these kept
 * `parent.company_id IN (SELECT user_company_ids())`, which is membership.
 *
 * The result was a hole with the parent apparently locked: a viewer could not
 * touch `supplier_invoices`, but could INSERT, UPDATE and DELETE its line
 * items — and the lines are where the amounts, VAT rates and account numbers
 * are. Rewriting a line is rewriting the invoice.
 *
 * The shape test in tenant-isolation-matrix proves no policy has that form any
 * more. This proves the behaviour, which is what actually matters.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

describe('child rows require write capability on the parent company', () => {
  let companyId: string
  let ownerId: string
  let viewerId: string
  let supplierInvoiceId: string
  let itemId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    companyId = seeded.companyId
    ownerId = seeded.userId

    viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })

    const supplierId = randomUUID()
    await getPool().query(
      `INSERT INTO public.suppliers (id, user_id, company_id, name)
       VALUES ($1, $2, $3, 'Leverantören AB')`,
      [supplierId, ownerId, companyId],
    )

    supplierInvoiceId = randomUUID()
    await getPool().query(
      `INSERT INTO public.supplier_invoices
         (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
          invoice_date, due_date, received_date, status, currency,
          subtotal, vat_amount, total, vat_treatment, paid_amount, remaining_amount)
       VALUES ($1, $2, $3, $4, 1, 'LEV-1',
               '2026-03-01', '2026-03-31', '2026-03-01', 'registered', 'SEK',
               10000, 2500, 12500, 'standard_25', 0, 12500)`,
      [supplierInvoiceId, ownerId, companyId, supplierId],
    )

    itemId = randomUUID()
    await getPool().query(
      `INSERT INTO public.supplier_invoice_items
         (id, supplier_invoice_id, sort_order, description, quantity, unit,
          unit_price, line_total, account_number, vat_rate, vat_amount)
       VALUES ($1, $2, 1, 'Konsultarvode', 1, 'st', 10000, 10000, '6550', 25, 2500)`,
      [itemId, supplierInvoiceId],
    )
  })

  it('refuses a viewer rewriting an existing invoice line', async () => {
    await withUserContext(viewerId, async (client) => {
      const result = await client.query(
        `UPDATE public.supplier_invoice_items SET unit_price = 1, line_total = 1 WHERE id = $1`,
        [itemId],
      )
      expect(result.rowCount).toBe(0)
    })

    const { rows } = await getPool().query(
      `SELECT line_total FROM public.supplier_invoice_items WHERE id = $1`,
      [itemId],
    )
    expect(Number(rows[0].line_total)).toBe(10000)
  })

  it('refuses a viewer adding a line to someone else’s invoice', async () => {
    await expect(
      withUserContext(viewerId, async (client) => {
        await client.query(
          `INSERT INTO public.supplier_invoice_items
             (supplier_invoice_id, sort_order, description, quantity, unit,
              unit_price, line_total, account_number, vat_rate, vat_amount)
           VALUES ($1, 2, 'Påhittad rad', 1, 'st', 9999, 9999, '6550', 25, 2500)`,
          [supplierInvoiceId],
        )
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('refuses a viewer deleting a line', async () => {
    await withUserContext(viewerId, async (client) => {
      const result = await client.query(
        `DELETE FROM public.supplier_invoice_items WHERE id = $1`,
        [itemId],
      )
      expect(result.rowCount).toBe(0)
    })

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.supplier_invoice_items WHERE id = $1`,
      [itemId],
    )
    expect(rows[0].n).toBe(1)
  })

  it('still lets the owner edit the line', async () => {
    // The other half: the gate must not break the product.
    await withUserContext(ownerId, async (client) => {
      const result = await client.query(
        `UPDATE public.supplier_invoice_items SET description = 'Konsultarvode mars' WHERE id = $1`,
        [itemId],
      )
      expect(result.rowCount).toBe(1)
    })
  })

  it('refuses a member of another company outright', async () => {
    const other = await seedCompany()

    await withUserContext(other.userId, async (client) => {
      const result = await client.query(
        `UPDATE public.supplier_invoice_items SET line_total = 1 WHERE id = $1`,
        [itemId],
      )
      expect(result.rowCount).toBe(0)
    })
  })

  it('applies the same gate to receipt line items', async () => {
    const receiptId = randomUUID()
    await getPool().query(
      `INSERT INTO public.receipts (id, user_id, company_id, image_url, status)
       VALUES ($1, $2, $3, 'https://example.invalid/kvitto.jpg', 'pending')`,
      [receiptId, ownerId, companyId],
    )

    await expect(
      withUserContext(viewerId, async (client) => {
        await client.query(
          `INSERT INTO public.receipt_line_items (receipt_id, description, line_total)
           VALUES ($1, 'Påhittad rad', 250)`,
          [receiptId],
        )
      }),
    ).rejects.toThrow(/row-level security/i)
  })
})
