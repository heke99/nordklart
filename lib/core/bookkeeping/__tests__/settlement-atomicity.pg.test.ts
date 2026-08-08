import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withServiceRole } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertCompanySettings,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

/**
 * End-to-end contract for settle_customer_invoice / settle_supplier_invoice.
 *
 * The pre-existing pg-real coverage only drove these RPCs down the ROLLBACK
 * path (an invalid settlement leaves no idempotency residue). Nothing ever
 * drove one to SUCCESS, which is why both functions shipped committing with a
 * commit_method their own CHECK constraint forbade — every real settlement
 * failed in production while the suite stayed green.
 *
 * These tests assert the committed end state, not just the RPC's return value.
 */

async function seed() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertCompanySettings({ companyId })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    name: '2026',
  })
  return { userId, companyId, fiscalPeriodId }
}

async function insertCustomerInvoice(params: {
  userId: string
  companyId: string
  total: number
  status?: string
}): Promise<string> {
  const customerId = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Testkund AB')`,
    [customerId, params.userId, params.companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        status, currency, total, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, '2026-1', '2026-03-01', '2026-03-31',
             $5, 'SEK', $6, 0, $6)`,
    [invoiceId, params.userId, params.companyId, customerId, params.status ?? 'sent', params.total],
  )
  return invoiceId
}

/** The draft the service stages today: debit 1930 / credit 1510. */
async function stageSettlementDraft(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  invoiceId: string
  amount: number
  paymentDate: string
}): Promise<string> {
  const entryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, source_id, status)
     VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Kundbetalning', 'invoice_paid', $6, 'draft')`,
    [entryId, params.userId, params.companyId, params.fiscalPeriodId, params.paymentDate, params.invoiceId],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', $2, 0), ($1, '1510', 0, $2)`,
    [entryId, params.amount],
  )
  return entryId
}

async function settleCustomer(params: {
  userId: string
  companyId: string
  invoiceId: string
  draftId: string
  amount: number
  expectedRemaining: number
  idempotencyKey: string
  paymentDate?: string
  bankTransactionId?: string | null
}): Promise<Record<string, unknown>> {
  const { rows } = await withServiceRole((client) => client.query<{ result: Record<string, unknown> }>(
    `SELECT public.settle_customer_invoice(
       $1::uuid, $2::uuid, $3::uuid, $4::date, $5::numeric, 'SEK', 0,
       $6::uuid, $7, $8, $9, NULL, NULL, $10::uuid, $11::numeric
     ) AS result`,
    [
      params.companyId,
      params.invoiceId,
      params.userId,
      params.paymentDate ?? '2026-04-01',
      params.amount,
      params.bankTransactionId ?? null,
      params.idempotencyKey,
      'a'.repeat(64),
      `req_${randomUUID()}`,
      params.draftId,
      params.expectedRemaining,
    ],
  ))
  return rows[0].result
}

/**
 * Asserts the stable machine code the RPC raises.
 *
 * The RPCs put the human message in MESSAGE and the contract code in DETAIL
 * (`{"code":"INVOICE_PAID_RACE"}`), so matching on the message text would pin
 * the tests to Swedish prose instead of the stable code the API maps on.
 */
async function expectSettlementCode(run: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown
  try {
    await run()
  } catch (error) {
    raised = error
  }
  expect(raised, `expected the call to fail with ${code}`).toBeDefined()
  const detail = (raised as { detail?: string }).detail ?? ''
  expect(detail).toContain(code)
}

describe('settle_customer_invoice — committed end state', () => {
  it('posts the voucher, records the payment and closes the invoice', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const draftId = await stageSettlementDraft({
      ...seeded, invoiceId, amount: 1000, paymentDate: '2026-04-01',
    })

    // Regression: this call previously aborted with
    // journal_entries_commit_method_check because the RPC commits with
    // commit_method = 'atomic_customer_settlement'.
    const result = await settleCustomer({
      ...seeded, invoiceId, draftId, amount: 1000,
      expectedRemaining: 1000, idempotencyKey: `idem-${randomUUID()}`,
    })
    expect(result).toBeTruthy()

    const { rows: entry } = await getPool().query<{
      status: string; voucher_number: number; commit_method: string
    }>(
      `SELECT status, voucher_number, commit_method FROM public.journal_entries WHERE id = $1`,
      [draftId],
    )
    expect(entry[0].status).toBe('posted')
    expect(entry[0].voucher_number).toBeGreaterThan(0)
    expect(entry[0].commit_method).toBe('atomic_customer_settlement')

    const { rows: payments } = await getPool().query<{ amount: string; journal_entry_id: string }>(
      `SELECT amount::text, journal_entry_id FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(payments).toHaveLength(1)
    expect(Number(payments[0].amount)).toBe(1000)
    expect(payments[0].journal_entry_id).toBe(draftId)

    const { rows: invoice } = await getPool().query<{
      status: string; paid_amount: string; remaining_amount: string; paid_at: string | null
    }>(
      `SELECT status, paid_amount::text, remaining_amount::text, paid_at::text
       FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(invoice[0].status).toBe('paid')
    expect(Number(invoice[0].paid_amount)).toBe(1000)
    expect(Number(invoice[0].remaining_amount)).toBe(0)
    expect(invoice[0].paid_at).not.toBeNull()
  })

  it('settles a partial payment and leaves the invoice partially_paid', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const draftId = await stageSettlementDraft({
      ...seeded, invoiceId, amount: 400, paymentDate: '2026-04-01',
    })

    await settleCustomer({
      ...seeded, invoiceId, draftId, amount: 400,
      expectedRemaining: 1000, idempotencyKey: `idem-${randomUUID()}`,
    })

    const { rows } = await getPool().query<{
      status: string; paid_amount: string; remaining_amount: string
    }>(
      `SELECT status, paid_amount::text, remaining_amount::text
       FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(rows[0].status).toBe('partially_paid')
    expect(Number(rows[0].paid_amount)).toBe(400)
    expect(Number(rows[0].remaining_amount)).toBe(600)
  })

  it('replays the same idempotency key with exactly one economic effect', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const draftId = await stageSettlementDraft({
      ...seeded, invoiceId, amount: 1000, paymentDate: '2026-04-01',
    })
    const key = `idem-${randomUUID()}`

    const first = await settleCustomer({
      ...seeded, invoiceId, draftId, amount: 1000, expectedRemaining: 1000, idempotencyKey: key,
    })
    const replay = await settleCustomer({
      ...seeded, invoiceId, draftId, amount: 1000, expectedRemaining: 1000, idempotencyKey: key,
    })
    expect(replay).toEqual(first)

    const { rows: counts } = await getPool().query<{ payments: string; entries: string }>(
      `SELECT
         (SELECT count(*) FROM public.invoice_payments WHERE invoice_id = $1)::text AS payments,
         (SELECT count(*) FROM public.journal_entries
           WHERE company_id = $2 AND source_id = $1 AND status = 'posted')::text AS entries`,
      [invoiceId, seeded.companyId],
    )
    expect(counts[0].payments).toBe('1')
    expect(counts[0].entries).toBe('1')
  })

  it('rejects the same idempotency key with a different payload', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const draftId = await stageSettlementDraft({
      ...seeded, invoiceId, amount: 1000, paymentDate: '2026-04-01',
    })
    const key = `idem-${randomUUID()}`
    await settleCustomer({
      ...seeded, invoiceId, draftId, amount: 1000, expectedRemaining: 1000, idempotencyKey: key,
    })

    await expectSettlementCode(() => withServiceRole((client) => client.query(
      `SELECT public.settle_customer_invoice(
         $1::uuid, $2::uuid, $3::uuid, '2026-04-01'::date, 1000::numeric, 'SEK', 0,
         NULL, $4, $5, $6, NULL, NULL, $7::uuid, 1000::numeric
       )`,
      [
        seeded.companyId, invoiceId, seeded.userId, key,
        'b'.repeat(64), `req_${randomUUID()}`, draftId,
      ],
    )), 'IDEMPOTENCY_KEY_REUSE')
  })

  it('refuses a settlement in another company', async () => {
    const a = await seed()
    const b = await seed()
    const invoiceId = await insertCustomerInvoice({ ...a, total: 1000 })
    const draftId = await stageSettlementDraft({
      ...a, invoiceId, amount: 1000, paymentDate: '2026-04-01',
    })

    // Company B's owner has no write access to company A.
    await expectSettlementCode(() => settleCustomer({
      userId: b.userId,
      companyId: a.companyId,
      invoiceId,
      draftId,
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'COMPANY_WRITE_FORBIDDEN')

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(rows[0].count).toBe('0')
  })

  it('refuses a currency mismatch and leaves nothing behind', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const draftId = await stageSettlementDraft({
      ...seeded, invoiceId, amount: 1000, paymentDate: '2026-04-01',
    })

    await expectSettlementCode(() => withServiceRole((client) => client.query(
      `SELECT public.settle_customer_invoice(
         $1::uuid, $2::uuid, $3::uuid, '2026-04-01'::date, 1000::numeric, 'EUR', 0,
         NULL, $4, $5, $6, NULL, NULL, $7::uuid, 1000::numeric
       )`,
      [
        seeded.companyId, invoiceId, seeded.userId, `idem-${randomUUID()}`,
        'a'.repeat(64), `req_${randomUUID()}`, draftId,
      ],
    )), 'PAYMENT_CURRENCY_MISMATCH')

    const { rows } = await getPool().query<{ status: string }>(
      `SELECT status FROM public.journal_entries WHERE id = $1`,
      [draftId],
    )
    expect(rows[0].status).toBe('draft')
  })

  it('refuses a stale expected remaining amount (concurrent change)', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const draftId = await stageSettlementDraft({
      ...seeded, invoiceId, amount: 1000, paymentDate: '2026-04-01',
    })

    await expectSettlementCode(() => settleCustomer({
      ...seeded, invoiceId, draftId, amount: 1000,
      expectedRemaining: 750, idempotencyKey: `idem-${randomUUID()}`,
    }), 'INVOICE_PAID_RACE')
  })

  it('refuses to settle an invoice that is not payable', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000, status: 'draft' })
    const draftId = await stageSettlementDraft({
      ...seeded, invoiceId, amount: 1000, paymentDate: '2026-04-01',
    })

    await expectSettlementCode(() => settleCustomer({
      ...seeded, invoiceId, draftId, amount: 1000,
      expectedRemaining: 1000, idempotencyKey: `idem-${randomUUID()}`,
    }), 'INVOICE_PAID_NOT_PAYABLE')
  })
})
