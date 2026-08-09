import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from '@/tests/pg/fixtures'
import { backendPid, getPool, openUserTx, waitUntilBlocked } from '@/tests/pg/setup'

/**
 * Bank allocation under concurrency.
 *
 * The uniqueness key here was wrong in production once already: it was
 * (company_id, transaction_id), which made the ordinary Swedish case — one
 * bankgiro payment settling several supplier invoices — impossible, because
 * the second payment row on the same transaction always collided. The fix
 * narrowed it to (company_id, transaction_id, invoice_id).
 *
 * That narrowing is only safe if the surrounding invariants still hold under
 * concurrency, so this file pins both directions: the legitimate fan-out must
 * work, and the genuine double-booking must still be impossible even when two
 * workers reach for the same transaction at the same time.
 */

let arrivalSeq = 0

async function seedTenant() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
  })
  return { userId, companyId, fiscalPeriodId }
}

async function insertSupplier(userId: string, companyId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers
       (id, user_id, company_id, name, supplier_type, country, default_payment_terms, default_currency)
     VALUES ($1, $2, $3, 'Leverantör AB', 'swedish_business', 'SE', 30, 'SEK')`,
    [id, userId, companyId],
  )
  return id
}

async function insertSupplierInvoice(params: {
  userId: string
  companyId: string
  supplierId: string
  total: number
}): Promise<string> {
  const id = randomUUID()
  const arrivalNumber = (Date.now() % 1_000_000) * 1000 + arrivalSeq++
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, arrival_number, supplier_invoice_number,
        invoice_date, due_date, received_date, status, currency,
        subtotal, vat_amount, total, paid_amount, remaining_amount,
        vat_treatment, reverse_charge, is_credit_note)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-06-01', '2026-07-01', '2026-06-01',
             'approved', 'SEK', $7, 0, $7, 0, $7, 'standard_25', false, false)`,
    [id, params.userId, params.companyId, params.supplierId, arrivalNumber,
      `LF-${arrivalNumber}`, params.total],
  )
  return id
}

async function insertTransaction(params: {
  userId: string
  companyId: string
  amount: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, category)
     VALUES ($1, $2, $3, '2026-06-05', 'Bankgiro', $4, 'SEK', 'uncategorized')`,
    [id, params.userId, params.companyId, params.amount],
  )
  return id
}

interface BatchResult {
  ok: boolean
  code?: string
  journal_entry_id?: string
  total_allocated?: number
  allocations?: Array<{ supplier_invoice_id?: string; payment_id: string; amount: number }>
}

async function allocateOn(
  client: Parameters<typeof backendPid>[0],
  params: { txId: string; companyId: string; allocations: unknown[] },
): Promise<BatchResult> {
  const { rows } = await client.query<{ result: BatchResult }>(
    `SELECT public.match_batch_allocate($1::uuid, $2::jsonb, $3::uuid) AS result`,
    [params.txId, JSON.stringify(params.allocations), params.companyId],
  )
  return rows[0].result
}

async function allocationRowsFor(txId: string) {
  const { rows } = await getPool().query<{
    supplier_invoice_id: string; amount: string; company_id: string
  }>(
    `SELECT supplier_invoice_id, amount::text, company_id
     FROM public.supplier_invoice_payments WHERE transaction_id = $1`,
    [txId],
  )
  return rows
}

describe('bank allocation — legitimate fan-out', () => {
  it('allocates one bank transaction across three supplier invoices', async () => {
    const seeded = await seedTenant()
    const supplierId = await insertSupplier(seeded.userId, seeded.companyId)
    const invoices = await Promise.all([
      insertSupplierInvoice({ ...seeded, supplierId, total: 1000 }),
      insertSupplierInvoice({ ...seeded, supplierId, total: 2000 }),
      insertSupplierInvoice({ ...seeded, supplierId, total: 500 }),
    ])
    const txId = await insertTransaction({ ...seeded, amount: -3500 })

    const tx = await openUserTx(seeded.userId)
    try {
      const result = await allocateOn(tx.client, {
        txId,
        companyId: seeded.companyId,
        allocations: invoices.map((id, index) => ({
          kind: 'supplier_invoice',
          supplier_invoice_id: id,
          amount: [1000, 2000, 500][index],
        })),
      })
      expect(result.ok).toBe(true)
      await tx.commit()
    } finally {
      await tx.rollback()
    }

    const rows = await allocationRowsFor(txId)
    expect(rows).toHaveLength(3)
    // One transaction, three payment rows, all in the right company, summing
    // to exactly the bank movement. This is the case the old uniqueness key
    // made impossible.
    const total = rows.reduce((sum, row) => sum + Number(row.amount), 0)
    expect(total).toBe(3500)
    expect(new Set(rows.map((row) => row.company_id))).toEqual(new Set([seeded.companyId]))
    expect(new Set(rows.map((row) => row.supplier_invoice_id)).size).toBe(3)
  })
})

describe('bank allocation — forbidden double booking', () => {
  it('rejects a second payment row for the same transaction and invoice', async () => {
    const seeded = await seedTenant()
    const supplierId = await insertSupplier(seeded.userId, seeded.companyId)
    const invoiceId = await insertSupplierInvoice({ ...seeded, supplierId, total: 1000 })
    const txId = await insertTransaction({ ...seeded, amount: -1000 })

    await getPool().query(
      `INSERT INTO public.supplier_invoice_payments
         (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, transaction_id)
       VALUES ($1, $2, $3, '2026-06-05', 1000, 'SEK', $4)`,
      [seeded.userId, seeded.companyId, invoiceId, txId],
    )

    let raised: unknown
    try {
      await getPool().query(
        `INSERT INTO public.supplier_invoice_payments
           (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, transaction_id)
         VALUES ($1, $2, $3, '2026-06-05', 1000, 'SEK', $4)`,
        [seeded.userId, seeded.companyId, invoiceId, txId],
      )
    } catch (error) {
      raised = error
    }
    expect(raised, 'the same transaction+invoice pair must not book twice').toBeDefined()
    expect(await allocationRowsFor(txId)).toHaveLength(1)
  })

  it('still allows the same transaction against a different invoice', async () => {
    // The narrowed key must reject the pair, not the transaction. Without this
    // the previous test would also pass under the old, broken key.
    const seeded = await seedTenant()
    const supplierId = await insertSupplier(seeded.userId, seeded.companyId)
    const first = await insertSupplierInvoice({ ...seeded, supplierId, total: 1000 })
    const second = await insertSupplierInvoice({ ...seeded, supplierId, total: 1000 })
    const txId = await insertTransaction({ ...seeded, amount: -2000 })

    for (const invoiceId of [first, second]) {
      await getPool().query(
        `INSERT INTO public.supplier_invoice_payments
           (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, transaction_id)
         VALUES ($1, $2, $3, '2026-06-05', 1000, 'SEK', $4)`,
        [seeded.userId, seeded.companyId, invoiceId, txId],
      )
    }
    expect(await allocationRowsFor(txId)).toHaveLength(2)
  })
})

describe('bank allocation — parallel workers on one transaction', () => {
  it('lets exactly one worker book the transaction and never over-allocates', async () => {
    const seeded = await seedTenant()
    const supplierId = await insertSupplier(seeded.userId, seeded.companyId)
    const invoiceA = await insertSupplierInvoice({ ...seeded, supplierId, total: 3500 })
    const invoiceB = await insertSupplierInvoice({ ...seeded, supplierId, total: 3500 })
    const txId = await insertTransaction({ ...seeded, amount: -3500 })

    const first = await openUserTx(seeded.userId)
    const second = await openUserTx(seeded.userId)
    let secondResult: BatchResult | undefined
    try {
      const firstResult = await allocateOn(first.client, {
        txId,
        companyId: seeded.companyId,
        allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: invoiceA, amount: 3500 }],
      })
      expect(firstResult.ok).toBe(true)

      // Second worker, same transaction, different invoice. The RPC locks the
      // transaction row first, so this must block rather than race ahead and
      // allocate the same money twice.
      const secondPid = await backendPid(second.client)
      const secondCall = allocateOn(second.client, {
        txId,
        companyId: seeded.companyId,
        allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: invoiceB, amount: 3500 }],
      })
      expect(await waitUntilBlocked(secondPid)).toBe(true)

      await first.commit()
      secondResult = await secondCall
      await second.commit()
    } finally {
      await first.rollback()
      await second.rollback()
    }

    // The loser is refused because the transaction already carries a voucher.
    expect(secondResult?.ok).toBe(false)
    expect(secondResult?.code).toBe('BATCH_TX_ALREADY_BOOKED')

    const rows = await allocationRowsFor(txId)
    expect(rows).toHaveLength(1)
    const total = rows.reduce((sum, row) => sum + Number(row.amount), 0)
    expect(total).toBeLessThanOrEqual(3500)
    expect(total).toBe(3500)
    expect(rows[0].supplier_invoice_id).toBe(invoiceA)

    // Exactly one voucher for the transaction.
    const { rows: entries } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries
       WHERE id = (SELECT journal_entry_id FROM public.transactions WHERE id = $1)`,
      [txId],
    )
    expect(entries[0].count).toBe('1')
  })

  it('serializes two identical batches and books the money once', async () => {
    const seeded = await seedTenant()
    const supplierId = await insertSupplier(seeded.userId, seeded.companyId)
    const invoiceId = await insertSupplierInvoice({ ...seeded, supplierId, total: 1200 })
    const txId = await insertTransaction({ ...seeded, amount: -1200 })
    const allocations = [{ kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 1200 }]

    const first = await openUserTx(seeded.userId)
    const second = await openUserTx(seeded.userId)
    let secondResult: BatchResult | undefined
    try {
      const firstResult = await allocateOn(first.client, { txId, companyId: seeded.companyId, allocations })
      expect(firstResult.ok).toBe(true)

      const secondPid = await backendPid(second.client)
      const secondCall = allocateOn(second.client, { txId, companyId: seeded.companyId, allocations })
      expect(await waitUntilBlocked(secondPid)).toBe(true)

      await first.commit()
      secondResult = await secondCall
      await second.commit()
    } finally {
      await first.rollback()
      await second.rollback()
    }

    expect(secondResult?.ok).toBe(false)
    expect(secondResult?.code).toBe('BATCH_TX_ALREADY_BOOKED')

    const rows = await allocationRowsFor(txId)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(1200)

    const { rows: invoice } = await getPool().query<{ paid_amount: string; remaining_amount: string }>(
      `SELECT paid_amount::text, remaining_amount::text FROM public.supplier_invoices WHERE id = $1`,
      [invoiceId],
    )
    expect(Number(invoice[0].paid_amount)).toBe(1200)
    expect(Number(invoice[0].remaining_amount)).toBe(0)
  })
})

describe('bank allocation — tenant boundaries', () => {
  it('refuses to allocate another company transaction', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const supplierId = await insertSupplier(a.userId, a.companyId)
    const invoiceId = await insertSupplierInvoice({ ...a, supplierId, total: 1000 })
    const txId = await insertTransaction({ ...a, amount: -1000 })

    const tx = await openUserTx(b.userId)
    try {
      // B's user, A's company id: the membership check must stop this before
      // any row is touched.
      const result = await allocateOn(tx.client, {
        txId,
        companyId: a.companyId,
        allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 1000 }],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BATCH_UNAUTHORIZED')
      await tx.commit()
    } finally {
      await tx.rollback()
    }

    expect(await allocationRowsFor(txId)).toHaveLength(0)
  })

  it('refuses a transaction that belongs to a different company than the caller claims', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const supplierId = await insertSupplier(b.userId, b.companyId)
    const invoiceId = await insertSupplierInvoice({ ...b, supplierId, total: 1000 })
    const txId = await insertTransaction({ ...a, amount: -1000 })

    const tx = await openUserTx(b.userId)
    try {
      // B is a legitimate member of B, but the transaction lives in A. The
      // company-scoped lookup must not find it.
      const result = await allocateOn(tx.client, {
        txId,
        companyId: b.companyId,
        allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: invoiceId, amount: 1000 }],
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe('BATCH_TX_NOT_FOUND')
      await tx.commit()
    } finally {
      await tx.rollback()
    }

    expect(await allocationRowsFor(txId)).toHaveLength(0)
  })
})
