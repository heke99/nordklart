import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withServiceRole } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertChartAccounts,
  insertCompany,
  insertCompanyMember,
  insertCompanySettings,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'

/**
 * settle_customer_invoice_v2 / settle_supplier_invoice_v2 (H-03).
 *
 * v1 took a draft journal entry the application had already committed in a
 * separate transaction, and cancelled it afterwards if the settlement rolled
 * back. That compensation is best effort: a process that dies between the two
 * statements strands a draft voucher with no payment behind it.
 *
 * v2 receives the entry as a plan and creates it inside the settlement
 * transaction. The invariant these tests exist to protect is therefore not
 * "the happy path works" but "a rejected settlement leaves NOTHING behind" —
 * no journal entry in any status, not even a cancelled one.
 */

async function seed() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertCompanySettings({ companyId })
  await insertChartAccounts({ userId, companyId })
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
  currency?: string
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
     VALUES ($1, $2, $3, $4, $5, '2026-03-01', '2026-03-31',
             $6, $7, $8, 0, $8)`,
    [
      invoiceId, params.userId, params.companyId, customerId,
      `2026-${Math.floor(Math.random() * 100000)}`,
      params.status ?? 'sent', params.currency ?? 'SEK', params.total,
    ],
  )
  return invoiceId
}

async function insertSupplierInvoice(params: {
  userId: string
  companyId: string
  total: number
  status?: string
}): Promise<string> {
  const supplierId = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name)
     VALUES ($1, $2, $3, 'Leverantör AB')`,
    [supplierId, params.userId, params.companyId],
  )
  const invoiceId = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, supplier_invoice_number, arrival_number,
        invoice_date, due_date, status, currency, total, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-03-01', '2026-03-31',
             $7, 'SEK', $8, 0, $8)`,
    [
      invoiceId, params.userId, params.companyId, supplierId,
      `LF-${Math.floor(Math.random() * 100000)}`,
      Math.floor(Math.random() * 1000000),
      params.status ?? 'approved', params.total,
    ],
  )
  return invoiceId
}

/** The plan the service now sends instead of a pre-created draft. */
function customerPlan(params: {
  fiscalPeriodId: string
  invoiceId: string
  amount: number
  paymentDate?: string
  sourceType?: string
  lines?: Array<Record<string, unknown>>
}) {
  return {
    fiscal_period_id: params.fiscalPeriodId,
    entry_date: params.paymentDate ?? '2026-04-01',
    description: 'Inbetalning kundfaktura 2026-1',
    source_type: params.sourceType ?? 'invoice_paid',
    source_id: params.invoiceId,
    voucher_series: 'A',
    lines: params.lines ?? [
      { account_number: '1930', debit_amount: params.amount, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: params.amount },
    ],
  }
}

function supplierPlan(params: {
  fiscalPeriodId: string
  invoiceId: string
  amount: number
  paymentDate?: string
}) {
  return {
    fiscal_period_id: params.fiscalPeriodId,
    entry_date: params.paymentDate ?? '2026-04-01',
    description: 'Utbetalning leverantörsfaktura LF-1',
    source_type: 'supplier_invoice_paid',
    source_id: params.invoiceId,
    voucher_series: 'A',
    lines: [
      { account_number: '2440', debit_amount: params.amount, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: params.amount },
    ],
  }
}

async function settleCustomerV2(params: {
  userId: string
  companyId: string
  invoiceId: string
  plan: unknown
  amount: number
  expectedRemaining: number
  idempotencyKey: string
  currency?: string
  paymentDate?: string
  payloadHash?: string
}): Promise<Record<string, unknown>> {
  const { rows } = await withServiceRole((client) => client.query<{ result: Record<string, unknown> }>(
    `SELECT public.settle_customer_invoice_v2(
       $1::uuid, $2::uuid, $3::uuid, $4::date, $5::numeric, $6, 0,
       NULL, $7, $8, $9, NULL, NULL, $10::jsonb, $11::numeric
     ) AS result`,
    [
      params.companyId,
      params.invoiceId,
      params.userId,
      params.paymentDate ?? '2026-04-01',
      params.amount,
      params.currency ?? 'SEK',
      params.idempotencyKey,
      params.payloadHash ?? 'a'.repeat(64),
      `req_${randomUUID()}`,
      JSON.stringify(params.plan),
      params.expectedRemaining,
    ],
  ))
  return rows[0].result
}

async function settleSupplierV2(params: {
  userId: string
  companyId: string
  invoiceId: string
  plan: unknown
  amount: number
  expectedRemaining: number
  idempotencyKey: string
}): Promise<Record<string, unknown>> {
  const { rows } = await withServiceRole((client) => client.query<{ result: Record<string, unknown> }>(
    `SELECT public.settle_supplier_invoice_v2(
       $1::uuid, $2::uuid, $3::uuid, '2026-04-01'::date, $4::numeric, 'SEK', 0,
       NULL, $5, $6, $7, NULL, NULL, $8::jsonb, $9::numeric
     ) AS result`,
    [
      params.companyId,
      params.invoiceId,
      params.userId,
      params.amount,
      params.idempotencyKey,
      'a'.repeat(64),
      `req_${randomUUID()}`,
      JSON.stringify(params.plan),
      params.expectedRemaining,
    ],
  ))
  return rows[0].result
}

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

/** Journal entries for this source, in ANY status. */
async function entriesFor(companyId: string, sourceId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ status: string }>(
    `SELECT status FROM public.journal_entries WHERE company_id = $1 AND source_id = $2`,
    [companyId, sourceId],
  )
  return rows.map((row) => row.status)
}

describe('settle_customer_invoice_v2', () => {
  it('creates, posts and links the voucher from the plan alone', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })

    const result = await settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    })

    const entryId = result.journal_entry_id as string
    expect(entryId).toBeTruthy()

    const { rows: entry } = await getPool().query<{
      status: string; voucher_number: number; voucher_series: string; commit_method: string
      source_type: string; entry_date: string
    }>(
      `SELECT status, voucher_number, voucher_series, commit_method, source_type, entry_date::text
       FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entry[0].status).toBe('posted')
    expect(entry[0].voucher_number).toBeGreaterThan(0)
    expect(entry[0].voucher_series).toBe('A')
    expect(entry[0].commit_method).toBe('atomic_customer_settlement')
    expect(entry[0].source_type).toBe('invoice_paid')
    expect(entry[0].entry_date).toBe('2026-04-01')

    // The plan's account numbers must resolve to the company's chart, not be
    // written as dangling text.
    const { rows: lines } = await getPool().query<{
      account_number: string; debit_amount: string; credit_amount: string
      account_id: string | null; sort_order: number
    }>(
      `SELECT account_number, debit_amount::text, credit_amount::text, account_id, sort_order
       FROM public.journal_entry_lines WHERE journal_entry_id = $1 ORDER BY sort_order`,
      [entryId],
    )
    expect(lines).toHaveLength(2)
    expect(lines[0].account_number).toBe('1930')
    expect(Number(lines[0].debit_amount)).toBe(1000)
    expect(lines[0].account_id).not.toBeNull()
    expect(lines[1].account_number).toBe('1510')
    expect(Number(lines[1].credit_amount)).toBe(1000)
    expect(lines[1].account_id).not.toBeNull()

    const { rows: invoice } = await getPool().query<{
      status: string; payment_journal_entry_id: string; remaining_amount: string
    }>(
      `SELECT status, payment_journal_entry_id, remaining_amount::text
       FROM public.invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(invoice[0].status).toBe('paid')
    expect(invoice[0].payment_journal_entry_id).toBe(entryId)
    expect(Number(invoice[0].remaining_amount)).toBe(0)
  })

  it('books an overpayment plan as a customer credit', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })

    const result = await settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({
        fiscalPeriodId: seeded.fiscalPeriodId,
        invoiceId,
        amount: 1200,
        lines: [
          { account_number: '1930', debit_amount: 1200, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
          { account_number: '2440', debit_amount: 0, credit_amount: 200 },
        ],
      }),
      amount: 1200,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    })

    expect(Number(result.applied_amount)).toBe(1000)
    expect(Number(result.overpayment_amount)).toBe(200)
    expect(result.customer_credit_id).toBeTruthy()
  })

  // The whole point of v2: a rejected settlement must not leave a voucher.
  it('leaves no journal entry at all when the invoice is not payable', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000, status: 'draft' })

    await expectSettlementCode(() => settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'INVOICE_PAID_NOT_PAYABLE')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
  })

  it('leaves no journal entry when the expected remaining amount is stale', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })

    await expectSettlementCode(() => settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 }),
      amount: 1000,
      expectedRemaining: 750,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'INVOICE_PAID_RACE')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
  })

  it('leaves no journal entry when the actor cannot write the company', async () => {
    const a = await seed()
    const b = await seed()
    const invoiceId = await insertCustomerInvoice({ ...a, total: 1000 })

    await expectSettlementCode(() => settleCustomerV2({
      userId: b.userId,
      companyId: a.companyId,
      invoiceId,
      plan: customerPlan({ fiscalPeriodId: a.fiscalPeriodId, invoiceId, amount: 1000 }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'COMPANY_WRITE_FORBIDDEN')

    expect(await entriesFor(a.companyId, invoiceId)).toEqual([])
  })

  it('rejects an unbalanced plan and leaves no journal entry', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })

    await expectSettlementCode(() => settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({
        fiscalPeriodId: seeded.fiscalPeriodId,
        invoiceId,
        amount: 1000,
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 900 },
        ],
      }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'INVOICE_PAID_LINES_UNBALANCED')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
  })

  it('rejects a plan naming an account outside the company chart', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })

    await expectSettlementCode(() => settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({
        fiscalPeriodId: seeded.fiscalPeriodId,
        invoiceId,
        amount: 1000,
        lines: [
          { account_number: '9999', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1510', debit_amount: 0, credit_amount: 1000 },
        ],
      }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'ACCOUNTS_NOT_IN_CHART')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
  })

  it('rejects a plan whose source_id points at a different invoice', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const otherInvoiceId = await insertCustomerInvoice({ ...seeded, total: 500 })

    await expectSettlementCode(() => settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({
        fiscalPeriodId: seeded.fiscalPeriodId,
        invoiceId: otherInvoiceId,
        amount: 1000,
      }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'INVOICE_PAID_BOOK_FAILED')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
    expect(await entriesFor(seeded.companyId, otherInvoiceId)).toEqual([])
  })

  it('rejects a plan with a source_type that is not a payment', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })

    await expectSettlementCode(() => settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({
        fiscalPeriodId: seeded.fiscalPeriodId,
        invoiceId,
        amount: 1000,
        sourceType: 'manual',
      }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'INVOICE_PAID_BOOK_FAILED')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
  })

  it('rejects a plan whose entry_date differs from the payment date', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })

    await expectSettlementCode(() => settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({
        fiscalPeriodId: seeded.fiscalPeriodId,
        invoiceId,
        amount: 1000,
        paymentDate: '2026-05-01',
      }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'INVOICE_PAID_BOOK_FAILED')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
  })

  it('refuses a locked period and leaves no journal entry', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    await getPool().query(
      `UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`,
      [seeded.fiscalPeriodId],
    )

    await expectSettlementCode(() => settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'PERIOD_LOCKED')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
  })

  it('replays an idempotency key without creating a second voucher', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const key = `idem-${randomUUID()}`
    const plan = customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 })

    const first = await settleCustomerV2({
      ...seeded, invoiceId, plan, amount: 1000, expectedRemaining: 1000, idempotencyKey: key,
    })
    const replay = await settleCustomerV2({
      ...seeded, invoiceId, plan, amount: 1000, expectedRemaining: 1000, idempotencyKey: key,
    })

    expect(replay).toEqual(first)
    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual(['posted'])

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.invoice_payments WHERE invoice_id = $1`,
      [invoiceId],
    )
    expect(rows[0].count).toBe('1')
  })

  it('rejects the same idempotency key with a different payload', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const key = `idem-${randomUUID()}`
    const plan = customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 })

    await settleCustomerV2({
      ...seeded, invoiceId, plan, amount: 1000, expectedRemaining: 1000, idempotencyKey: key,
    })
    await expectSettlementCode(() => settleCustomerV2({
      ...seeded, invoiceId, plan, amount: 1000, expectedRemaining: 1000,
      idempotencyKey: key, payloadHash: 'b'.repeat(64),
    }), 'IDEMPOTENCY_KEY_REUSE')
  })

  it('refuses a currency mismatch and leaves no journal entry', async () => {
    const seeded = await seed()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })

    await expectSettlementCode(() => settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 }),
      amount: 1000,
      expectedRemaining: 1000,
      currency: 'EUR',
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'PAYMENT_CURRENCY_MISMATCH')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
  })
})

describe('settle_supplier_invoice_v2', () => {
  it('creates, posts and links the voucher from the plan alone', async () => {
    const seeded = await seed()
    const invoiceId = await insertSupplierInvoice({ ...seeded, total: 2500 })

    const result = await settleSupplierV2({
      ...seeded,
      invoiceId,
      plan: supplierPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 2500 }),
      amount: 2500,
      expectedRemaining: 2500,
      idempotencyKey: `idem-${randomUUID()}`,
    })

    const entryId = result.journal_entry_id as string
    const { rows: entry } = await getPool().query<{ status: string; commit_method: string }>(
      `SELECT status, commit_method FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(entry[0].status).toBe('posted')
    expect(entry[0].commit_method).toBe('atomic_supplier_settlement')

    const { rows: invoice } = await getPool().query<{
      status: string; remaining_amount: string; payment_journal_entry_id: string
    }>(
      `SELECT status, remaining_amount::text, payment_journal_entry_id
       FROM public.supplier_invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(invoice[0].status).toBe('paid')
    expect(Number(invoice[0].remaining_amount)).toBe(0)
    expect(invoice[0].payment_journal_entry_id).toBe(entryId)
  })

  it('settles a partial payment and leaves the invoice partially_paid', async () => {
    const seeded = await seed()
    const invoiceId = await insertSupplierInvoice({ ...seeded, total: 2500 })

    await settleSupplierV2({
      ...seeded,
      invoiceId,
      plan: supplierPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 }),
      amount: 1000,
      expectedRemaining: 2500,
      idempotencyKey: `idem-${randomUUID()}`,
    })

    const { rows } = await getPool().query<{ status: string; remaining_amount: string }>(
      `SELECT status, remaining_amount::text FROM public.supplier_invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(rows[0].status).toBe('partially_paid')
    expect(Number(rows[0].remaining_amount)).toBe(1500)
  })

  it('leaves no journal entry when the supplier invoice is not payable', async () => {
    const seeded = await seed()
    const invoiceId = await insertSupplierInvoice({ ...seeded, total: 2500, status: 'paid' })

    await expectSettlementCode(() => settleSupplierV2({
      ...seeded,
      invoiceId,
      plan: supplierPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 2500 }),
      amount: 2500,
      expectedRemaining: 2500,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'SI_PAID_NOT_PAYABLE')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
  })

  it('leaves no journal entry when the payment exceeds the remaining amount', async () => {
    const seeded = await seed()
    const invoiceId = await insertSupplierInvoice({ ...seeded, total: 2500 })

    await expectSettlementCode(() => settleSupplierV2({
      ...seeded,
      invoiceId,
      plan: supplierPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 3000 }),
      amount: 3000,
      expectedRemaining: 2500,
      idempotencyKey: `idem-${randomUUID()}`,
    }), 'VALIDATION_ERROR')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
  })

  it('rejects a plan carrying a customer-payment source_type', async () => {
    const seeded = await seed()
    const invoiceId = await insertSupplierInvoice({ ...seeded, total: 2500 })
    const plan = {
      ...supplierPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 2500 }),
      source_type: 'invoice_paid',
    }

    await expectSettlementCode(() => settleSupplierV2({
      ...seeded, invoiceId, plan, amount: 2500,
      expectedRemaining: 2500, idempotencyKey: `idem-${randomUUID()}`,
    }), 'SI_PAID_FAILED')

    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual([])
  })

  it('replays an idempotency key without creating a second voucher', async () => {
    const seeded = await seed()
    const invoiceId = await insertSupplierInvoice({ ...seeded, total: 2500 })
    const key = `idem-${randomUUID()}`
    const plan = supplierPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 2500 })

    const first = await settleSupplierV2({
      ...seeded, invoiceId, plan, amount: 2500, expectedRemaining: 2500, idempotencyKey: key,
    })
    const replay = await settleSupplierV2({
      ...seeded, invoiceId, plan, amount: 2500, expectedRemaining: 2500, idempotencyKey: key,
    })

    expect(replay).toEqual(first)
    expect(await entriesFor(seeded.companyId, invoiceId)).toEqual(['posted'])
  })
})
