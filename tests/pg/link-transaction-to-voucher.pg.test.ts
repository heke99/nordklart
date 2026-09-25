import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertDraftJournalEntry, insertTransaction, seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/** Covers 20260925126000_link_transaction_to_voucher_atomic. */
async function setup(invoiceStatus = 'sent') {
  const s = await seedCompany()
  const voucher = await insertDraftJournalEntry({ ...s, status: 'posted', voucherNumber: Math.floor(Math.random() * 1e6) + 1 })
  const tx = await insertTransaction({ companyId: s.companyId, userId: s.userId, amount: 400, currency: 'SEK' })
  const { rows: [cust] } = await getPool().query<{ id: string }>(
    `INSERT INTO public.customers (company_id, user_id, name) VALUES ($1, $2, 'Kund AB') RETURNING id`, [s.companyId, s.userId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices (id, company_id, user_id, customer_id, invoice_number, invoice_date, due_date, status, currency, total, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $6, '2026-05-01', '2026-05-31', $5, 'SEK', 1000, 0, 1000)`,
    [invoiceId, s.companyId, s.userId, cust.id, invoiceStatus, `T-${invoiceId.slice(0, 8)}`],
  )
  return { ...s, voucher, tx, invoiceId }
}

describe('link_transaction_to_existing_voucher', () => {
  it('links the transaction, updates the invoice and records the payment together', async () => {
    const s = await setup()
    await withUserContext(s.userId, async (c) => {
      const { rows } = await c.query(`SELECT public.link_transaction_to_existing_voucher($1, $2, $3, $4, $5) AS r`,
        [s.companyId, s.userId, s.tx, s.voucher, s.invoiceId])
      expect(rows[0].r).toMatchObject({ ok: true, invoiceStatus: 'partially_paid' })
      const inv = await c.query(`SELECT status, paid_amount::float AS p, remaining_amount::float AS r FROM public.invoices WHERE id = $1`, [s.invoiceId])
      expect(inv.rows[0]).toEqual({ status: 'partially_paid', p: 400, r: 600 })
      const tx = await c.query(`SELECT journal_entry_id, invoice_id FROM public.transactions WHERE id = $1`, [s.tx])
      expect(tx.rows[0]).toEqual({ journal_entry_id: s.voucher, invoice_id: s.invoiceId })
      const pay = await c.query(`SELECT count(*)::int AS n FROM public.invoice_payments WHERE transaction_id = $1`, [s.tx])
      expect(pay.rows[0].n).toBe(1)
    })
  })

  it('changes nothing when the invoice is no longer open', async () => {
    const s = await setup('paid')
    await withUserContext(s.userId, async (c) => {
      const { rows } = await c.query(`SELECT public.link_transaction_to_existing_voucher($1, $2, $3, $4, $5) AS r`,
        [s.companyId, s.userId, s.tx, s.voucher, s.invoiceId])
      expect(rows[0].r).toMatchObject({ ok: false, code: 'LINK_TX_INVOICE_NOT_OPEN' })
      const tx = await c.query(`SELECT journal_entry_id FROM public.transactions WHERE id = $1`, [s.tx])
      expect(tx.rows[0].journal_entry_id).toBeNull()
    })
  })

  it('refuses a second link of the same transaction', async () => {
    const s = await setup()
    await withUserContext(s.userId, async (c) => {
      await c.query(`SELECT public.link_transaction_to_existing_voucher($1, $2, $3, $4, NULL)`, [s.companyId, s.userId, s.tx, s.voucher])
      const { rows } = await c.query(`SELECT public.link_transaction_to_existing_voucher($1, $2, $3, $4, NULL) AS r`, [s.companyId, s.userId, s.tx, s.voucher])
      expect(rows[0].r).toMatchObject({ ok: false, code: 'LINK_TX_TX_ALREADY_LINKED' })
    })
  })
})
