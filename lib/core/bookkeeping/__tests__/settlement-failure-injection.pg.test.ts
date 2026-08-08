import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPool, openServiceRoleTx, withServiceRole } from '@/tests/pg/setup'
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
  settleCustomerV2,
  settlementCode,
  settleSupplierOn,
  supplierInvoiceState,
  supplierPlan,
} from '@/tests/pg/settlement-fixtures'

/**
 * H-05 failure injection: the settlement must be all-or-nothing at EVERY stage.
 *
 * A settlement writes eight or nine things in sequence — voucher header, lines,
 * idempotency claim, voucher commit, payment row, invoice aggregate, bank
 * allocation, outbox, audit, result. "It rolls back" is only true if it is true
 * at each of those boundaries, and the interesting failures are the late ones:
 * a crash after the payment row but before the invoice aggregate would leave
 * the books claiming money moved while the invoice still shows it outstanding.
 *
 * Failure is injected with real BEFORE triggers rather than by mocking, so the
 * rollback under test is PostgreSQL's own. Each trigger is a no-op unless the
 * calling transaction has set `nordklart.fail_stage` to its stage name, which
 * keeps them inert for every other test sharing this database.
 */

const STAGES = {
  journal_header: { table: 'journal_entries', event: 'BEFORE INSERT' },
  journal_lines: { table: 'journal_entry_lines', event: 'BEFORE INSERT' },
  idempotency_claim: { table: 'financial_operation_idempotency', event: 'BEFORE INSERT' },
  voucher_commit: { table: 'journal_entries', event: 'BEFORE UPDATE' },
  customer_payment_row: { table: 'invoice_payments', event: 'BEFORE INSERT' },
  supplier_payment_row: { table: 'supplier_invoice_payments', event: 'BEFORE INSERT' },
  invoice_aggregate: { table: 'invoices', event: 'BEFORE UPDATE' },
  supplier_aggregate: { table: 'supplier_invoices', event: 'BEFORE UPDATE' },
  bank_allocation: { table: 'transactions', event: 'BEFORE UPDATE' },
  outbox: { table: 'financial_outbox_events', event: 'BEFORE INSERT' },
  audit: { table: 'audit_log', event: 'BEFORE INSERT' },
  result_registration: { table: 'financial_operation_idempotency', event: 'BEFORE UPDATE' },
} as const

type Stage = keyof typeof STAGES

beforeAll(async () => {
  await getPool().query(`
    CREATE OR REPLACE FUNCTION public.nordklart_test_fail_injection()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      -- Inert unless THIS transaction asked for this stage to fail, so the
      -- triggers can stay installed without disturbing any other test.
      IF current_setting('nordklart.fail_stage', true) = TG_ARGV[0] THEN
        RAISE EXCEPTION 'injected failure at stage %', TG_ARGV[0]
          USING ERRCODE = 'P0001', DETAIL = '{"code":"INJECTED_FAILURE"}';
      END IF;
      RETURN NEW;
    END;
    $fn$;
  `)
  for (const [stage, { table, event }] of Object.entries(STAGES)) {
    await getPool().query(`DROP TRIGGER IF EXISTS zz_fail_${stage} ON public.${table}`)
    await getPool().query(
      `CREATE TRIGGER zz_fail_${stage} ${event} ON public.${table}
       FOR EACH ROW EXECUTE FUNCTION public.nordklart_test_fail_injection('${stage}')`,
    )
  }
})

afterAll(async () => {
  for (const [stage, { table }] of Object.entries(STAGES)) {
    await getPool().query(`DROP TRIGGER IF EXISTS zz_fail_${stage} ON public.${table}`)
  }
  await getPool().query('DROP FUNCTION IF EXISTS public.nordklart_test_fail_injection()')
})

/** Runs `fn` in a service-role transaction with `stage` armed to fail. */
async function withInjectedFailure(
  stage: Stage,
  fn: (client: Parameters<typeof settleCustomerOn>[0]) => Promise<unknown>,
): Promise<unknown> {
  const tx = await openServiceRoleTx()
  let raised: unknown
  try {
    await tx.client.query(`SELECT set_config('nordklart.fail_stage', $1, true)`, [stage])
    await fn(tx.client)
  } catch (error) {
    raised = error
  } finally {
    // The RPC raised, so the transaction is aborted either way; rolling back is
    // exactly what the API layer does when the RPC returns an error.
    await tx.rollback()
  }
  return raised
}

/** Nothing economic may survive a failed settlement, anywhere. */
async function expectNothingPersisted(params: {
  companyId: string
  invoiceId: string
  paymentTable: 'invoice_payments' | 'supplier_invoice_payments'
  paymentColumn: 'invoice_id' | 'supplier_invoice_id'
  bankTransactionId?: string
}) {
  expect(await entryStatusesFor(params.companyId, params.invoiceId)).toEqual([])
  expect(await countRows(params.paymentTable, params.paymentColumn, params.invoiceId)).toBe(0)

  const { rows: lines } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM public.journal_entry_lines l
     JOIN public.journal_entries e ON e.id = l.journal_entry_id
     WHERE e.company_id = $1 AND e.source_id = $2`,
    [params.companyId, params.invoiceId],
  )
  expect(lines[0].count).toBe('0')

  const { rows: idem } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM public.financial_operation_idempotency
     WHERE company_id = $1`,
    [params.companyId],
  )
  expect(idem[0].count).toBe('0')

  const { rows: outbox } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM public.financial_outbox_events
     WHERE company_id = $1 AND aggregate_id = $2`,
    [params.companyId, params.invoiceId],
  )
  expect(outbox[0].count).toBe('0')

  if (params.bankTransactionId) {
    const { rows } = await getPool().query<{
      invoice_id: string | null; supplier_invoice_id: string | null; journal_entry_id: string | null
    }>(
      `SELECT invoice_id, supplier_invoice_id, journal_entry_id
       FROM public.transactions WHERE id = $1`,
      [params.bankTransactionId],
    )
    expect(rows[0].invoice_id).toBeNull()
    expect(rows[0].supplier_invoice_id).toBeNull()
    expect(rows[0].journal_entry_id).toBeNull()
  }
}

const CUSTOMER_STAGES: Stage[] = [
  'journal_header',
  'journal_lines',
  'idempotency_claim',
  'voucher_commit',
  'customer_payment_row',
  'invoice_aggregate',
  'bank_allocation',
  'outbox',
  'audit',
  'result_registration',
]

describe('settle_customer_invoice_v2 — failure at every stage', () => {
  for (const stage of CUSTOMER_STAGES) {
    it(`rolls the whole settlement back when ${stage} fails`, async () => {
      const seeded = await seedSettlementCompany()
      const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
      const txId = await insertBankTransaction({ ...seeded, amount: 1000 })

      const raised = await withInjectedFailure(stage, (client) => settleCustomerOn(client, {
        ...seeded,
        invoiceId,
        plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 }),
        amount: 1000,
        expectedRemaining: 1000,
        idempotencyKey: `idem-${randomUUID()}`,
        bankTransactionId: txId,
      }))

      expect(raised, `stage ${stage} should have failed the settlement`).toBeDefined()
      expect(settlementCode(raised)).toBe('INJECTED_FAILURE')

      await expectNothingPersisted({
        companyId: seeded.companyId,
        invoiceId,
        paymentTable: 'invoice_payments',
        paymentColumn: 'invoice_id',
        bankTransactionId: txId,
      })

      const invoice = await customerInvoiceState(invoiceId)
      expect(invoice.status).toBe('sent')
      expect(Number(invoice.paid_amount)).toBe(0)
      expect(Number(invoice.remaining_amount)).toBe(1000)
      expect(invoice.payment_journal_entry_id).toBeNull()
    })
  }

  it('settles normally once the injected failure is gone', async () => {
    // Guards the harness itself: if the triggers leaked past their stage, every
    // test above would "pass" for the wrong reason.
    const seeded = await seedSettlementCompany()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })

    const result = await settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: `idem-${randomUUID()}`,
    })

    expect(result.status).toBe('paid')
    expect(await entryStatusesFor(seeded.companyId, invoiceId)).toEqual(['posted'])
  })
})

const SUPPLIER_STAGES: Stage[] = [
  'journal_header',
  'journal_lines',
  'idempotency_claim',
  'voucher_commit',
  'supplier_payment_row',
  'supplier_aggregate',
  'bank_allocation',
  'outbox',
  'audit',
  'result_registration',
]

describe('settle_supplier_invoice_v2 — failure at every stage', () => {
  for (const stage of SUPPLIER_STAGES) {
    it(`rolls the whole settlement back when ${stage} fails`, async () => {
      const seeded = await seedSettlementCompany()
      const invoiceId = await insertSupplierInvoice({ ...seeded, total: 2500 })
      const txId = await insertBankTransaction({ ...seeded, amount: -2500 })

      const raised = await withInjectedFailure(stage, (client) => settleSupplierOn(client, {
        ...seeded,
        invoiceId,
        plan: supplierPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 2500 }),
        amount: 2500,
        expectedRemaining: 2500,
        idempotencyKey: `idem-${randomUUID()}`,
        bankTransactionId: txId,
      }))

      expect(raised, `stage ${stage} should have failed the settlement`).toBeDefined()
      expect(settlementCode(raised)).toBe('INJECTED_FAILURE')

      await expectNothingPersisted({
        companyId: seeded.companyId,
        invoiceId,
        paymentTable: 'supplier_invoice_payments',
        paymentColumn: 'supplier_invoice_id',
        bankTransactionId: txId,
      })

      const invoice = await supplierInvoiceState(invoiceId)
      expect(invoice.status).toBe('approved')
      expect(Number(invoice.paid_amount)).toBe(0)
      expect(Number(invoice.remaining_amount)).toBe(2500)
      expect(invoice.payment_journal_entry_id).toBeNull()
    })
  }
})

describe('settlement — commit succeeded, response lost', () => {
  /**
   * The one failure mode that must NOT roll anything back. PostgreSQL committed;
   * the HTTP response never reached the client; the client retries. Treating
   * that as a fresh settlement books the payment twice, and treating it as a
   * failure tells the user their paid invoice is unpaid. The idempotency record
   * commits atomically with the money, which is what makes the retry answerable.
   */
  it('answers the retry from the committed record without booking anything new', async () => {
    const seeded = await seedSettlementCompany()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const key = `idem-${randomUUID()}`
    const payloadHash = 'c'.repeat(64)
    const args = {
      ...seeded,
      invoiceId,
      plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: key,
      payloadHash,
    }

    const committed = await settleCustomerV2(args)

    // The service's recovery path: ask whether the operation already landed.
    const replay = await withServiceRole(async (client) => {
      const { rows } = await client.query<{ result: Record<string, unknown> }>(
        `SELECT public.get_financial_operation_result($1::uuid, $2, $3, $4) AS result`,
        [seeded.companyId, 'customer_invoice_settlement', key, payloadHash],
      )
      return rows[0].result
    })
    expect(replay).toEqual(committed)

    // And a full retry of the original call is equally safe.
    const retried = await settleCustomerV2(args)
    expect(retried).toEqual(committed)

    expect(await entryStatusesFor(seeded.companyId, invoiceId)).toEqual(['posted'])
    expect(await countRows('invoice_payments', 'invoice_id', invoiceId)).toBe(1)

    const { rows: outbox } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.financial_outbox_events
       WHERE company_id = $1 AND aggregate_id = $2`,
      [seeded.companyId, invoiceId],
    )
    expect(outbox[0].count).toBe('1')

    const invoice = await customerInvoiceState(invoiceId)
    expect(invoice.status).toBe('paid')
    expect(Number(invoice.paid_amount)).toBe(1000)
  })

  it('refuses to answer a retry that carries a different payload', async () => {
    // The recovery path must not be a way to launder a changed request into a
    // previous result. It does not merely decline to answer — it raises, so a
    // caller that ignored the distinction cannot mistake "different request"
    // for "nothing committed yet" and settle a second time.
    const seeded = await seedSettlementCompany()
    const invoiceId = await insertCustomerInvoice({ ...seeded, total: 1000 })
    const key = `idem-${randomUUID()}`

    await settleCustomerV2({
      ...seeded,
      invoiceId,
      plan: customerPlan({ fiscalPeriodId: seeded.fiscalPeriodId, invoiceId, amount: 1000 }),
      amount: 1000,
      expectedRemaining: 1000,
      idempotencyKey: key,
      payloadHash: 'd'.repeat(64),
    })

    let raised: unknown
    try {
      await withServiceRole((client) => client.query(
        `SELECT public.get_financial_operation_result($1::uuid, $2, $3, $4) AS result`,
        [seeded.companyId, 'customer_invoice_settlement', key, 'e'.repeat(64)],
      ))
    } catch (error) {
      raised = error
    }
    expect(settlementCode(raised)).toBe('IDEMPOTENCY_KEY_REUSE')

    // The original settlement is untouched by the rejected lookup.
    expect(await countRows('invoice_payments', 'invoice_id', invoiceId)).toBe(1)
    expect(await entryStatusesFor(seeded.companyId, invoiceId)).toEqual(['posted'])
  })
})
