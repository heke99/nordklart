import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getPool, withServiceRole } from './setup'
import {
  insertAuthUser,
  insertChartAccounts,
  insertCompany,
  insertCompanyMember,
  insertCompanySettings,
  insertFiscalPeriod,
} from './fixtures'

/**
 * Shared seed and call helpers for the settlement RPCs.
 *
 * Kept in one place because the atomicity suite and the concurrency suite must
 * drive the SAME calls — if one file's helper drifts (a different payload hash,
 * a different plan shape) the two suites quietly stop testing the same thing.
 */

export interface SettlementSeed {
  userId: string
  companyId: string
  fiscalPeriodId: string
}

export async function seedSettlementCompany(): Promise<SettlementSeed> {
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

export async function insertCustomerInvoice(params: {
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
     VALUES ($1, $2, $3, $4, $5, '2026-03-01', '2026-03-31', $6, $7, $8, 0, $8)`,
    [
      invoiceId, params.userId, params.companyId, customerId,
      `2026-${randomUUID().slice(0, 8)}`,
      params.status ?? 'sent', params.currency ?? 'SEK', params.total,
    ],
  )
  return invoiceId
}

export async function insertSupplierInvoice(params: {
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
     VALUES ($1, $2, $3, $4, $5, $6, '2026-03-01', '2026-03-31', $7, 'SEK', $8, 0, $8)`,
    [
      invoiceId, params.userId, params.companyId, supplierId,
      `LF-${randomUUID().slice(0, 8)}`,
      Math.floor(Math.random() * 100_000_000),
      params.status ?? 'approved', params.total,
    ],
  )
  return invoiceId
}

export async function insertBankTransaction(params: {
  userId: string
  companyId: string
  amount: number
  date?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency, is_business)
     VALUES ($1, $2, $3, $4, 'Bankhändelse', $5, 'SEK', true)`,
    [id, params.userId, params.companyId, params.date ?? '2026-04-01', params.amount],
  )
  return id
}

/** The customer payment voucher the settlement service plans. */
export function customerPlan(params: {
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
    description: 'Inbetalning kundfaktura',
    source_type: params.sourceType ?? 'invoice_paid',
    source_id: params.invoiceId,
    voucher_series: 'A',
    lines: params.lines ?? [
      { account_number: '1930', debit_amount: params.amount, credit_amount: 0 },
      { account_number: '1510', debit_amount: 0, credit_amount: params.amount },
    ],
  }
}

export function supplierPlan(params: {
  fiscalPeriodId: string
  invoiceId: string
  amount: number
  paymentDate?: string
}) {
  return {
    fiscal_period_id: params.fiscalPeriodId,
    entry_date: params.paymentDate ?? '2026-04-01',
    description: 'Utbetalning leverantörsfaktura',
    source_type: 'supplier_invoice_paid',
    source_id: params.invoiceId,
    voucher_series: 'A',
    lines: [
      { account_number: '2440', debit_amount: params.amount, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: params.amount },
    ],
  }
}

export interface SettleCustomerArgs {
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
  bankTransactionId?: string | null
}

const CUSTOMER_SQL = `SELECT public.settle_customer_invoice_v2(
  $1::uuid, $2::uuid, $3::uuid, $4::date, $5::numeric, $6, 0,
  $7::uuid, $8, $9, $10, NULL, NULL, $11::jsonb, $12::numeric
) AS result`

function customerParams(params: SettleCustomerArgs) {
  return [
    params.companyId,
    params.invoiceId,
    params.userId,
    params.paymentDate ?? '2026-04-01',
    params.amount,
    params.currency ?? 'SEK',
    params.bankTransactionId ?? null,
    params.idempotencyKey,
    params.payloadHash ?? 'a'.repeat(64),
    `req_${randomUUID()}`,
    JSON.stringify(params.plan),
    params.expectedRemaining,
  ]
}

/** Runs a customer settlement on a caller-owned (open) transaction. */
export async function settleCustomerOn(
  client: PoolClient,
  params: SettleCustomerArgs,
): Promise<Record<string, unknown>> {
  const { rows } = await client.query<{ result: Record<string, unknown> }>(
    CUSTOMER_SQL,
    customerParams(params),
  )
  return rows[0].result
}

export async function settleCustomerV2(
  params: SettleCustomerArgs,
): Promise<Record<string, unknown>> {
  return withServiceRole((client) => settleCustomerOn(client, params))
}

export interface SettleSupplierArgs {
  userId: string
  companyId: string
  invoiceId: string
  plan: unknown
  amount: number
  expectedRemaining: number
  idempotencyKey: string
  payloadHash?: string
  bankTransactionId?: string | null
}

const SUPPLIER_SQL = `SELECT public.settle_supplier_invoice_v2(
  $1::uuid, $2::uuid, $3::uuid, '2026-04-01'::date, $4::numeric, 'SEK', 0,
  $5::uuid, $6, $7, $8, NULL, NULL, $9::jsonb, $10::numeric
) AS result`

function supplierParams(params: SettleSupplierArgs) {
  return [
    params.companyId,
    params.invoiceId,
    params.userId,
    params.amount,
    params.bankTransactionId ?? null,
    params.idempotencyKey,
    params.payloadHash ?? 'a'.repeat(64),
    `req_${randomUUID()}`,
    JSON.stringify(params.plan),
    params.expectedRemaining,
  ]
}

export async function settleSupplierOn(
  client: PoolClient,
  params: SettleSupplierArgs,
): Promise<Record<string, unknown>> {
  const { rows } = await client.query<{ result: Record<string, unknown> }>(
    SUPPLIER_SQL,
    supplierParams(params),
  )
  return rows[0].result
}

export async function settleSupplierV2(
  params: SettleSupplierArgs,
): Promise<Record<string, unknown>> {
  return withServiceRole((client) => settleSupplierOn(client, params))
}

/**
 * Asserts the stable machine code the RPC raises.
 *
 * The RPCs put the human message in MESSAGE and the contract code in DETAIL
 * (`{"code":"INVOICE_PAID_RACE"}`), so matching on message text would pin tests
 * to Swedish prose instead of the stable code the API maps on.
 */
export function settlementCode(error: unknown): string | null {
  const detail = (error as { detail?: string } | null)?.detail
  if (!detail) return null
  try {
    return (JSON.parse(detail) as { code?: string }).code ?? null
  } catch {
    return detail.match(/"code"\s*:\s*"([A-Z0-9_]+)"/)?.[1] ?? null
  }
}

/** Journal entry statuses recorded for a source, in any status. */
export async function entryStatusesFor(companyId: string, sourceId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ status: string }>(
    `SELECT status FROM public.journal_entries WHERE company_id = $1 AND source_id = $2`,
    [companyId, sourceId],
  )
  return rows.map((row) => row.status)
}

export async function customerInvoiceState(invoiceId: string) {
  const { rows } = await getPool().query<{
    status: string; paid_amount: string; remaining_amount: string
    payment_journal_entry_id: string | null
  }>(
    `SELECT status, paid_amount::text, remaining_amount::text, payment_journal_entry_id
     FROM public.invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]
}

export async function supplierInvoiceState(invoiceId: string) {
  const { rows } = await getPool().query<{
    status: string; paid_amount: string; remaining_amount: string
    payment_journal_entry_id: string | null
  }>(
    `SELECT status, paid_amount::text, remaining_amount::text, payment_journal_entry_id
     FROM public.supplier_invoices WHERE id = $1`,
    [invoiceId],
  )
  return rows[0]
}

export async function countRows(table: string, column: string, value: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM public.${table} WHERE ${column} = $1`,
    [value],
  )
  return Number(rows[0].count)
}
