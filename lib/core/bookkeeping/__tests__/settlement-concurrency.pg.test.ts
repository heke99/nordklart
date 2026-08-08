import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { backendPid, getPool, openServiceRoleTx, waitUntilBlocked } from '@/tests/pg/setup'
import {
  countRows,
  customerInvoiceState,
  customerPlan,
  entryStatusesFor,
  insertBankTransaction,
  insertCustomerInvoice,
  insertSupplierInvoice,
  seedSettlementCompany,
  settleCustomerOn,
  settlementCode,
  settleSupplierOn,
  supplierInvoiceState,
  supplierPlan,
} from '@/tests/pg/settlement-fixtures'

/**
 * H-05: the settlement RPCs under real concurrency.
 *
 * settlement-v2-atomicity.pg.test.ts proves one transaction behaves. This file
 * proves two do, which is a different property and the one that actually
 * protects money: a duplicated click, a retried request and a bank worker
 * running beside a human all produce overlapping transactions against the same
 * invoice.
 *
 * Every test here holds two transactions open simultaneously and asserts that
 * the second one genuinely BLOCKS (via pg_blocking_pids) before the first
 * commits. Without that assertion a test can pass simply because the two calls
 * never overlapped, which proves nothing about the locking.
 */

/** Runs `fn` on a second connection while `pid` is known to be blocked by it. */
async function expectBlocked(pid: number): Promise<void> {
  const blocked = await waitUntilBlocked(pid)
  expect(blocked, 'second transaction should have blocked on the first').toBe(true)
}

describe('settle_customer_invoice_v2 — same idempotency key concurrently', () => {
  it('serializes on the key and yields exactly one economic effect', async () => {
    const seeded = await seedSettlementCompany()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const key = `idem-${randomUUID()}`
    const plan = customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 })
    const args = {
      ...seeded, invoiceId, plan, amount: 1000, expectedRemaining: 1000, idempotencyKey: key,
    }

    const first = await openServiceRoleTx()
    const second = await openServiceRoleTx()
    try {
      const firstResult = await settleCustomerOn(first.client, args)

      // Same key, concurrently. The advisory lock on the idempotency key must
      // hold this until the first transaction resolves — otherwise both would
      // read "no prior operation" and book two payments.
      const secondPid = await backendPid(second.client)
      const secondCall = settleCustomerOn(second.client, args)
      await expectBlocked(secondPid)

      await first.commit()
      const secondResult = await secondCall
      await second.commit()

      // Canonical replay: byte-identical result, not a second settlement.
      expect(secondResult).toEqual(firstResult)
    } finally {
      await first.rollback()
      await second.rollback()
    }

    expect(await entryStatusesFor(seeded.companyId, invoiceId)).toEqual(['posted'])
    expect(await countRows('invoice_payments', 'invoice_id', invoiceId)).toBe(1)

    const invoice = await customerInvoiceState(invoiceId)
    expect(invoice.status).toBe('paid')
    expect(Number(invoice.paid_amount)).toBe(1000)
    expect(Number(invoice.remaining_amount)).toBe(0)
  })

  it('rejects a concurrent reuse of the key with a different payload', async () => {
    const seeded = await seedSettlementCompany()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const key = `idem-${randomUUID()}`
    const plan = customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 })
    const base = {
      ...seeded, invoiceId, plan, amount: 1000, expectedRemaining: 1000, idempotencyKey: key,
    }

    const first = await openServiceRoleTx()
    const second = await openServiceRoleTx()
    let raised: unknown
    try {
      await settleCustomerOn(first.client, base)
      const secondPid = await backendPid(second.client)
      const secondCall = settleCustomerOn(second.client, {
        ...base, payloadHash: 'b'.repeat(64),
      }).catch((error) => { raised = error })
      await expectBlocked(secondPid)
      await first.commit()
      await secondCall
    } finally {
      await first.rollback()
      await second.rollback()
    }

    expect(settlementCode(raised)).toBe('IDEMPOTENCY_KEY_REUSE')
    expect(await countRows('invoice_payments', 'invoice_id', invoiceId)).toBe(1)
  })

  it('lets the second attempt through when the first rolls back', async () => {
    const seeded = await seedSettlementCompany()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const key = `idem-${randomUUID()}`
    const plan = customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 })
    const args = {
      ...seeded, invoiceId, plan, amount: 1000, expectedRemaining: 1000, idempotencyKey: key,
    }

    const first = await openServiceRoleTx()
    const second = await openServiceRoleTx()
    try {
      await settleCustomerOn(first.client, args)
      const secondPid = await backendPid(second.client)
      const secondCall = settleCustomerOn(second.client, args)
      await expectBlocked(secondPid)

      // The first attempt dies. Its idempotency row dies with it, so the retry
      // must be allowed to actually settle rather than replaying a result that
      // was never committed.
      await first.rollback()
      const result = await secondCall
      await second.commit()
      expect(result.status).toBe('paid')
    } finally {
      await first.rollback()
      await second.rollback()
    }

    expect(await entryStatusesFor(seeded.companyId, invoiceId)).toEqual(['posted'])
    expect(await countRows('invoice_payments', 'invoice_id', invoiceId)).toBe(1)
  })
})

describe('settle_customer_invoice_v2 — different keys, same invoice', () => {
  /**
   * The four overlap shapes. In every one the second transaction planned
   * against a remaining amount the first has already consumed, so it must be
   * rejected rather than land on stale state — but the guard that catches it
   * differs by shape, and each is pinned exactly rather than accepting either.
   *
   * A full first payment closes the invoice, so the loser is stopped by the
   * payability check before the amount is ever considered. A partial first
   * payment leaves the invoice payable, so the stale expected-remaining is what
   * catches it. Both are correct; asserting the wrong one would hide a real
   * change in which guard fires.
   */
  const overlaps: Array<{
    name: string; first: number; second: number; total: number; code: string
  }> = [
    { name: 'full + full', total: 1000, first: 1000, second: 1000, code: 'INVOICE_PAID_NOT_PAYABLE' },
    { name: 'partial + partial', total: 1000, first: 400, second: 400, code: 'INVOICE_PAID_RACE' },
    { name: 'partial + full', total: 1000, first: 400, second: 1000, code: 'INVOICE_PAID_RACE' },
    { name: 'full + partial', total: 1000, first: 1000, second: 400, code: 'INVOICE_PAID_NOT_PAYABLE' },
  ]

  for (const overlap of overlaps) {
    it(`${overlap.name}: the loser is rejected and nothing is overpaid`, async () => {
      const seeded = await seedSettlementCompany()
      const invoiceId = await insertCustomerInvoice({ ...seeded, total: overlap.total })

      const first = await openServiceRoleTx()
      const second = await openServiceRoleTx()
      let raised: unknown
      try {
        await settleCustomerOn(first.client, {
          ...seeded,
          invoiceId,
          plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: overlap.first }),
          amount: overlap.first,
          expectedRemaining: overlap.total,
          idempotencyKey: `idem-${randomUUID()}`,
        })

        // Distinct key, same invoice: the per-invoice advisory lock is the only
        // thing standing between these two and a double payment.
        const secondPid = await backendPid(second.client)
        const secondCall = settleCustomerOn(second.client, {
          ...seeded,
          invoiceId,
          plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: overlap.second }),
          amount: overlap.second,
          expectedRemaining: overlap.total,
          idempotencyKey: `idem-${randomUUID()}`,
        }).catch((error) => { raised = error })
        await expectBlocked(secondPid)

        await first.commit()
        await secondCall
        await second.commit()
      } finally {
        await first.rollback()
        await second.rollback()
      }

      expect(settlementCode(raised)).toBe(overlap.code)

      const invoice = await customerInvoiceState(invoiceId)
      expect(Number(invoice.paid_amount)).toBe(overlap.first)
      expect(Number(invoice.remaining_amount)).toBe(overlap.total - overlap.first)
      expect(Number(invoice.paid_amount)).toBeLessThanOrEqual(overlap.total)
      expect(await entryStatusesFor(seeded.companyId, invoiceId)).toEqual(['posted'])
      expect(await countRows('invoice_payments', 'invoice_id', invoiceId)).toBe(1)
    })
  }

  it('accepts a sequential second payment once it plans against fresh state', async () => {
    // The mirror image of the tests above: the guard must reject only STALE
    // state, never a legitimate follow-up payment. Without this, "reject on
    // race" would be indistinguishable from "reject every second payment".
    const seeded = await seedSettlementCompany()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })

    const first = await openServiceRoleTx()
    try {
      await settleCustomerOn(first.client, {
        ...seeded,
        invoiceId,
        plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 400 }),
        amount: 400,
        expectedRemaining: 1000,
        idempotencyKey: `idem-${randomUUID()}`,
      })
      await first.commit()
    } finally {
      await first.rollback()
    }

    const second = await openServiceRoleTx()
    try {
      const result = await settleCustomerOn(second.client, {
        ...seeded,
        invoiceId,
        plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 600 }),
        amount: 600,
        expectedRemaining: 600,
        idempotencyKey: `idem-${randomUUID()}`,
      })
      await second.commit()
      expect(result.status).toBe('paid')
    } finally {
      await second.rollback()
    }

    const invoice = await customerInvoiceState(invoiceId)
    expect(Number(invoice.paid_amount)).toBe(1000)
    expect(Number(invoice.remaining_amount)).toBe(0)
    expect(await countRows('invoice_payments', 'invoice_id', invoiceId)).toBe(2)
  })
})

describe('settle_supplier_invoice_v2 — concurrency', () => {
  it('replays the same idempotency key concurrently with one economic effect', async () => {
    const seeded = await seedSettlementCompany()
    const invoiceId = await insertSupplierInvoice({ ...seeded, total: 2500 })
    const key = `idem-${randomUUID()}`
    const plan = supplierPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 2500 })
    const args = {
      ...seeded, invoiceId, plan, amount: 2500, expectedRemaining: 2500, idempotencyKey: key,
    }

    const first = await openServiceRoleTx()
    const second = await openServiceRoleTx()
    try {
      const firstResult = await settleSupplierOn(first.client, args)
      const secondPid = await backendPid(second.client)
      const secondCall = settleSupplierOn(second.client, args)
      await expectBlocked(secondPid)
      await first.commit()
      const secondResult = await secondCall
      await second.commit()
      expect(secondResult).toEqual(firstResult)
    } finally {
      await first.rollback()
      await second.rollback()
    }

    expect(await entryStatusesFor(seeded.companyId, invoiceId)).toEqual(['posted'])
    expect(await countRows('supplier_invoice_payments', 'supplier_invoice_id', invoiceId)).toBe(1)
  })

  // Same reasoning as the customer matrix: a full first payment closes the
  // invoice and the payability guard fires; a partial one leaves it open and
  // the stale expected-remaining guard fires.
  const overlaps: Array<{
    name: string; first: number; second: number; total: number; code: string
  }> = [
    { name: 'full + full', total: 2500, first: 2500, second: 2500, code: 'SI_PAID_NOT_PAYABLE' },
    { name: 'partial + partial', total: 2500, first: 1000, second: 1000, code: 'SI_PAID_RACE' },
    { name: 'partial + full', total: 2500, first: 1000, second: 2500, code: 'SI_PAID_RACE' },
    { name: 'full + partial', total: 2500, first: 2500, second: 1000, code: 'SI_PAID_NOT_PAYABLE' },
  ]

  for (const overlap of overlaps) {
    it(`${overlap.name}: the loser is rejected and the supplier is never overpaid`, async () => {
      const seeded = await seedSettlementCompany()
      const invoiceId = await insertSupplierInvoice({ ...seeded, total: overlap.total })

      const first = await openServiceRoleTx()
      const second = await openServiceRoleTx()
      let raised: unknown
      try {
        await settleSupplierOn(first.client, {
          ...seeded,
          invoiceId,
          plan: supplierPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: overlap.first }),
          amount: overlap.first,
          expectedRemaining: overlap.total,
          idempotencyKey: `idem-${randomUUID()}`,
        })
        const secondPid = await backendPid(second.client)
        const secondCall = settleSupplierOn(second.client, {
          ...seeded,
          invoiceId,
          plan: supplierPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: overlap.second }),
          amount: overlap.second,
          expectedRemaining: overlap.total,
          idempotencyKey: `idem-${randomUUID()}`,
        }).catch((error) => { raised = error })
        await expectBlocked(secondPid)
        await first.commit()
        await secondCall
        await second.commit()
      } finally {
        await first.rollback()
        await second.rollback()
      }

      expect(settlementCode(raised)).toBe(overlap.code)

      const invoice = await supplierInvoiceState(invoiceId)
      expect(Number(invoice.paid_amount)).toBe(overlap.first)
      expect(Number(invoice.paid_amount)).toBeLessThanOrEqual(overlap.total)
      expect(await entryStatusesFor(seeded.companyId, invoiceId)).toEqual(['posted'])
      expect(await countRows('supplier_invoice_payments', 'supplier_invoice_id', invoiceId)).toBe(1)
    })
  }
})

describe('settlement locking — ordering and deadlock freedom', () => {
  it('serializes two customer settlements competing for the same bank transaction', async () => {
    // Different invoices, one bank transaction. The per-invoice advisory locks
    // do not overlap here, so the only thing preventing the transaction from
    // being allocated twice is the FOR UPDATE on transactions.
    const seeded = await seedSettlementCompany()
    const invoiceA = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const invoiceB = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const txId = await insertBankTransaction({ ...seeded, amount: 1000 })

    const first = await openServiceRoleTx()
    const second = await openServiceRoleTx()
    let raised: unknown
    try {
      await settleCustomerOn(first.client, {
        ...seeded,
        invoiceId: invoiceA,
        plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId: invoiceA, amount: 1000 }),
        amount: 1000,
        expectedRemaining: 1000,
        idempotencyKey: `idem-${randomUUID()}`,
        bankTransactionId: txId,
      })

      const secondPid = await backendPid(second.client)
      const secondCall = settleCustomerOn(second.client, {
        ...seeded,
        invoiceId: invoiceB,
        plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId: invoiceB, amount: 1000 }),
        amount: 1000,
        expectedRemaining: 1000,
        idempotencyKey: `idem-${randomUUID()}`,
        bankTransactionId: txId,
      }).catch((error) => { raised = error })
      await expectBlocked(secondPid)

      await first.commit()
      await secondCall
      await second.commit()
    } finally {
      await first.rollback()
      await second.rollback()
    }

    expect(settlementCode(raised)).toBe('BANK_TRANSACTION_ALREADY_ALLOCATED')

    const { rows } = await getPool().query<{ invoice_id: string | null }>(
      `SELECT invoice_id FROM public.transactions WHERE id = $1`,
      [txId],
    )
    expect(rows[0].invoice_id).toBe(invoiceA)
    expect(await entryStatusesFor(seeded.companyId, invoiceB)).toEqual([])
  })

  it('does not deadlock when a customer and a supplier settlement interleave', async () => {
    // Both paths take their own per-invoice advisory lock, then the shared
    // fiscal period, then the bank transaction — the same order. A pair that
    // acquired the period before the invoice would deadlock here.
    const seeded = await seedSettlementCompany()
    const customerId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const supplierId = await insertSupplierInvoice({ ...seeded, total: 2500 })

    const first = await openServiceRoleTx()
    const second = await openServiceRoleTx()
    try {
      // Interleaved deliberately: customer starts, supplier starts, then both
      // reach the shared fiscal period lock.
      await settleCustomerOn(first.client, {
        ...seeded,
        invoiceId: customerId,
        plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId: customerId, amount: 1000 }),
        amount: 1000,
        expectedRemaining: 1000,
        idempotencyKey: `idem-${randomUUID()}`,
      })

      const secondPid = await backendPid(second.client)
      const supplierCall = settleSupplierOn(second.client, {
        ...seeded,
        invoiceId: supplierId,
        plan: supplierPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId: supplierId, amount: 2500 }),
        amount: 2500,
        expectedRemaining: 2500,
        idempotencyKey: `idem-${randomUUID()}`,
      })
      await expectBlocked(secondPid)

      await first.commit()
      // A deadlock would surface as error 40P01 here rather than a clean result.
      const supplierResult = await supplierCall
      await second.commit()
      expect(supplierResult.status).toBe('paid')
    } finally {
      await first.rollback()
      await second.rollback()
    }

    expect((await customerInvoiceState(customerId)).status).toBe('paid')
    expect((await supplierInvoiceState(supplierId)).status).toBe('paid')
  })

  it('takes the per-invoice advisory lock before any row lock', async () => {
    // Lock-order regression guard. If the RPC ever reached the invoice row
    // before its advisory lock, two settlements would contend on the row first
    // and the advisory lock would stop being the serialization point — the
    // ordering that keeps this deadlock-free.
    const seeded = await seedSettlementCompany()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })

    const holder = await openServiceRoleTx()
    const contender = await openServiceRoleTx()
    try {
      // Hold ONLY the advisory lock the RPC uses, nothing else.
      await holder.client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':customer_invoice:' || $2, 0))`,
        [seeded.companyId, invoiceId],
      )

      const contenderPid = await backendPid(contender.client)
      const call = settleCustomerOn(contender.client, {
        ...seeded,
        invoiceId,
        plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 }),
        amount: 1000,
        expectedRemaining: 1000,
        idempotencyKey: `idem-${randomUUID()}`,
      })
      // Blocking here proves the advisory lock is reached before anything else
      // the settlement would otherwise have been able to do.
      await expectBlocked(contenderPid)

      await holder.rollback()
      const result = await call
      await contender.commit()
      expect(result.status).toBe('paid')
    } finally {
      await holder.rollback()
      await contender.rollback()
    }
  })
})
