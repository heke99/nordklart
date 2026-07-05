import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Covers 20260714150000_email_deliveries_and_reminder_idempotency:
 *   - email_deliveries dedupe claim: a pending/sent dedupe_key blocks a second
 *     claim (23505); a failed row frees the key for retry.
 *   - invoice_reminders: one pending/sent row per (invoice, level); a failed
 *     row does not block the retry insert.
 */

async function seedInvoice(): Promise<{ userId: string; companyId: string; invoiceId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })

  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name, customer_type, org_number)
     VALUES ($1, $2, $3, 'Påminnelse Kund AB', 'swedish_business', '5566778899')`,
    [customerId, userId, companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        currency, subtotal, vat_amount, total, vat_treatment, vat_rate, status,
        paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-05-01', '2026-05-31', 'SEK',
             10000, 2500, 12500, 'standard_25', 25, 'overdue', 0, 12500)`,
    [invoiceId, userId, companyId, customerId, `F-${invoiceId.slice(0, 8)}`],
  )
  return { userId, companyId, invoiceId }
}

describe('email_deliveries dedupe claims', () => {
  it('blocks a second claim for the same dedupe key while pending/sent', async () => {
    const { companyId } = await seedInvoice()
    const dedupeKey = `test:${randomUUID()}`

    await getPool().query(
      `INSERT INTO public.email_deliveries (company_id, recipient, subject, status, dedupe_key)
       VALUES ($1, 'kund@test.invalid', 'Test', 'pending', $2)`,
      [companyId, dedupeKey],
    )

    await expect(
      getPool().query(
        `INSERT INTO public.email_deliveries (company_id, recipient, subject, status, dedupe_key)
         VALUES ($1, 'kund@test.invalid', 'Test', 'pending', $2)`,
        [companyId, dedupeKey],
      ),
    ).rejects.toThrow(/duplicate key/i)
  })

  it('frees the dedupe key when the previous attempt failed', async () => {
    const { companyId } = await seedInvoice()
    const dedupeKey = `test:${randomUUID()}`

    await getPool().query(
      `INSERT INTO public.email_deliveries (company_id, recipient, subject, status, dedupe_key, error)
       VALUES ($1, 'kund@test.invalid', 'Test', 'failed', $2, 'timeout')`,
      [companyId, dedupeKey],
    )

    await expect(
      getPool().query(
        `INSERT INTO public.email_deliveries (company_id, recipient, subject, status, dedupe_key)
         VALUES ($1, 'kund@test.invalid', 'Test', 'pending', $2)`,
        [companyId, dedupeKey],
      ),
    ).resolves.toBeTruthy()
  })
})

describe('invoice_reminders send idempotency', () => {
  it('allows only one pending/sent row per (invoice, level)', async () => {
    const { userId, companyId, invoiceId } = await seedInvoice()

    await getPool().query(
      `INSERT INTO public.invoice_reminders (invoice_id, user_id, company_id, reminder_level, email_to, send_status)
       VALUES ($1, $2, $3, 1, 'kund@test.invalid', 'pending')`,
      [invoiceId, userId, companyId],
    )

    await expect(
      getPool().query(
        `INSERT INTO public.invoice_reminders (invoice_id, user_id, company_id, reminder_level, email_to, send_status)
         VALUES ($1, $2, $3, 1, 'kund@test.invalid', 'pending')`,
        [invoiceId, userId, companyId],
      ),
    ).rejects.toThrow(/duplicate key/i)

    // A different level is fine.
    await expect(
      getPool().query(
        `INSERT INTO public.invoice_reminders (invoice_id, user_id, company_id, reminder_level, email_to, send_status)
         VALUES ($1, $2, $3, 2, 'kund@test.invalid', 'pending')`,
        [invoiceId, userId, companyId],
      ),
    ).resolves.toBeTruthy()
  })

  it('a failed send does not consume the level — retry insert succeeds', async () => {
    const { userId, companyId, invoiceId } = await seedInvoice()

    await getPool().query(
      `INSERT INTO public.invoice_reminders (invoice_id, user_id, company_id, reminder_level, email_to, send_status)
       VALUES ($1, $2, $3, 1, 'kund@test.invalid', 'failed')`,
      [invoiceId, userId, companyId],
    )

    await expect(
      getPool().query(
        `INSERT INTO public.invoice_reminders (invoice_id, user_id, company_id, reminder_level, email_to, send_status)
         VALUES ($1, $2, $3, 1, 'kund@test.invalid', 'pending')`,
        [invoiceId, userId, companyId],
      ),
    ).resolves.toBeTruthy()
  })
})
