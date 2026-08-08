import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createDraftEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import {
  createSupplierInvoiceCashEntry,
  createSupplierInvoicePaymentEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

const log = createLogger('supplier-invoices/mark-paid')

export interface SupplierPaymentLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
}

export type LoadedSupplierInvoice = SupplierInvoice & {
  supplier?: { id?: string; name?: string; supplier_type?: string } | null
  items?: SupplierInvoiceItem[]
}

export interface SettleSupplierInvoiceRequest {
  invoice: LoadedSupplierInvoice
  paymentDate: string
  paymentAmount: number
  /** SEK amount used to clear 2440; differs from invoice-currency amount for FX payments. */
  ledgerPaymentAmount?: number
  exchangeRateDifference?: number
  /**
   * SEK that actually left the bank, for a FULL cash-method settlement of a
   * foreign-currency invoice. createSupplierInvoiceCashEntry derives the
   * payment-date rate from it (settledBankSek / invoice.total) so the payment
   * account credit equals the bank movement to the öre. Only meaningful for a
   * full settlement — a partial amount cannot pin a whole-invoice entry — and
   * omitted when no independent bank figure exists.
   */
  settledBankSek?: number
  paymentAccount?: string
  customLines?: SupplierPaymentLine[]
  notes?: string
  transactionId?: string | null
  paymentReference?: string | null
  idempotencyKey: string
  requestId: string
}

export type SettleSupplierInvoiceResult =
  | {
      ok: true
      supplierInvoiceId: string
      paymentId: string | null
      journalEntryId: string
      appliedAmount: number
      paidAmount: number
      remainingAmount: number
      status: 'paid' | 'partially_paid'
      paidAt: string | null
    }
  | {
      ok: false
      code: string
      details?: Record<string, unknown>
      bookkeepingError?: unknown
    }

type AtomicSupplierSettlement = {
  supplier_invoice_id: string
  payment_id: string | null
  journal_entry_id: string
  applied_amount: number
  paid_amount: number
  remaining_amount: number
  status: 'paid' | 'partially_paid'
  paid_at: string | null
  request_id: string
}

export async function settleSupplierInvoiceAtomic(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  request: SettleSupplierInvoiceRequest,
): Promise<SettleSupplierInvoiceResult> {
  const payloadHash = createHash('sha256')
    .update(JSON.stringify({
      supplierInvoiceId: request.invoice.id,
      paymentDate: request.paymentDate,
      paymentAmount: request.paymentAmount,
      ledgerPaymentAmount: request.ledgerPaymentAmount ?? request.paymentAmount,
      exchangeRateDifference: request.exchangeRateDifference ?? 0,
      paymentAccount: request.paymentAccount ?? null,
      customLines: request.customLines ?? null,
      notes: request.notes ?? null,
      transactionId: request.transactionId ?? null,
      paymentReference: request.paymentReference ?? null,
    }))
    .digest('hex')

  const service = createServiceClient()
  const { data: replay, error: replayError } = await service.rpc(
    'get_financial_operation_result',
    {
      p_company_id: companyId,
      p_operation_type: 'supplier_invoice_settlement',
      p_idempotency_key: request.idempotencyKey,
      p_payload_hash: payloadHash,
    },
  )
  if (replayError) return mapError(replayError)
  if (replay) return fromAtomic(replay as AtomicSupplierSettlement)

  const invoice = request.invoice
  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .maybeSingle()
  const accountingMethod = (settings as { accounting_method?: string } | null)?.accounting_method ?? 'accrual'
  const useCashEntry = !invoice.registration_journal_entry_id && accountingMethod === 'cash'
  if (useCashEntry && request.paymentAmount < invoice.remaining_amount - 0.005 && !request.customLines) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      details: {
        field: 'amount',
        message: 'Kontantmetoden kräver full betalning eller explicita balanserade rader.',
      },
    }
  }

  let draftJournalEntryId: string | null = null
  try {
    if (request.customLines) {
      const totalDebit = request.customLines.reduce((sum, line) => sum + line.debit_amount, 0)
      const totalCredit = request.customLines.reduce((sum, line) => sum + line.credit_amount, 0)
      if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
        return {
          ok: false,
          code: 'INVOICE_PAID_LINES_UNBALANCED',
          details: { total_debit: totalDebit, total_credit: totalCredit },
        }
      }
      const fiscalPeriodId = await findFiscalPeriod(service, companyId, request.paymentDate)
      if (!fiscalPeriodId) {
        return { ok: false, code: 'INVOICE_PAID_NO_FISCAL_PERIOD' }
      }
      const description = invoice.supplier?.name
        ? `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}, ${invoice.supplier.name}`
        : `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}`
      draftJournalEntryId = (await createDraftEntry(service, companyId, userId, {
        fiscal_period_id: fiscalPeriodId,
        entry_date: request.paymentDate,
        description,
        source_type: useCashEntry ? 'supplier_invoice_cash_payment' : 'supplier_invoice_paid',
        source_id: invoice.id,
        lines: request.customLines,
      })).id
    } else if (useCashEntry) {
      draftJournalEntryId = (await createSupplierInvoiceCashEntry(
        service,
        companyId,
        userId,
        invoice,
        invoice.items ?? [],
        request.paymentDate,
        invoice.supplier?.supplier_type ?? 'swedish_business',
        invoice.supplier?.name,
        request.paymentAccount,
        request.settledBankSek,
        { draftOnly: true },
      ))?.id ?? null
    } else {
      draftJournalEntryId = (await createSupplierInvoicePaymentEntry(
        service,
        companyId,
        userId,
        invoice,
        request.ledgerPaymentAmount ?? request.paymentAmount,
        request.paymentDate,
        request.exchangeRateDifference,
        invoice.supplier?.name,
        request.paymentAccount,
        { draftOnly: true },
      ))?.id ?? null
    }
  } catch (error) {
    if (isBookkeepingError(error)) {
      log.warn('supplier mark-paid: typed bookkeeping failure while staging draft', {
        companyId,
        supplierInvoiceId: invoice.id,
        requestId: request.requestId,
        reason: error instanceof Error ? error.message : 'unknown',
      })
      return { ok: false, code: 'SI_PAID_FAILED', bookkeepingError: error }
    }
    log.error('supplier mark-paid: draft journal entry creation failed', error as Error, {
      companyId,
      supplierInvoiceId: invoice.id,
      requestId: request.requestId,
    })
    return { ok: false, code: 'SI_PAID_FAILED' }
  }

  if (!draftJournalEntryId) {
    return { ok: false, code: 'INVOICE_PAID_NO_FISCAL_PERIOD' }
  }

  const { data, error } = await service.rpc('settle_supplier_invoice', {
    p_company_id: companyId,
    p_supplier_invoice_id: invoice.id,
    p_actor_user_id: userId,
    p_payment_date: request.paymentDate,
    p_payment_amount: request.paymentAmount,
    p_currency: invoice.currency,
    p_exchange_rate_difference: request.exchangeRateDifference ?? 0,
    p_bank_transaction_id: request.transactionId ?? null,
    p_idempotency_key: request.idempotencyKey,
    p_payload_hash: payloadHash,
    p_request_id: request.requestId,
    p_payment_reference: request.paymentReference ?? null,
    p_notes: request.notes ?? null,
    p_draft_journal_entry_id: draftJournalEntryId,
    p_expected_remaining_amount: invoice.remaining_amount,
  })

  if (error || !data) {
    // Resolve the classic "commit succeeded, HTTP response was lost" case
    // before cancelling anything. The idempotency row is committed atomically
    // with the supplier settlement.
    const { data: committedReplay } = await service.rpc('get_financial_operation_result', {
      p_company_id: companyId,
      p_operation_type: 'supplier_invoice_settlement',
      p_idempotency_key: request.idempotencyKey,
      p_payload_hash: payloadHash,
    })
    if (committedReplay) return fromAtomic(committedReplay as AtomicSupplierSettlement)

    const { error: cleanupError } = await service
      .from('journal_entries')
      .update({ status: 'cancelled' })
      .eq('company_id', companyId)
      .eq('id', draftJournalEntryId)
      .eq('status', 'draft')
    if (cleanupError) {
      log.error('failed to cancel rolled-back supplier payment draft', cleanupError as Error, {
        companyId,
        supplierInvoiceId: invoice.id,
        requestId: request.requestId,
      })
    }
    const atomicError = error ?? new Error('Atomic supplier settlement returned no result.')
    log.error('supplier mark-paid: atomic settlement failed', atomicError as Error, {
      companyId,
      supplierInvoiceId: invoice.id,
      requestId: request.requestId,
    })
    return mapError(atomicError)
  }

  return fromAtomic(data as AtomicSupplierSettlement)
}

function fromAtomic(atomic: AtomicSupplierSettlement): SettleSupplierInvoiceResult {
  return {
    ok: true,
    supplierInvoiceId: atomic.supplier_invoice_id,
    paymentId: atomic.payment_id,
    journalEntryId: atomic.journal_entry_id,
    appliedAmount: Number(atomic.applied_amount),
    paidAmount: Number(atomic.paid_amount),
    remainingAmount: Number(atomic.remaining_amount),
    status: atomic.status,
    paidAt: atomic.paid_at,
  }
}

function mapError(error: unknown): SettleSupplierInvoiceResult {
  const candidate = error as { message?: string; details?: string }
  let code = 'SI_PAID_FAILED'
  if (candidate.details) {
    try {
      code = (JSON.parse(candidate.details) as { code?: string }).code ?? code
    } catch {
      code = candidate.details.match(/"code"\s*:\s*"([A-Z0-9_]+)"/)?.[1] ?? code
    }
  }
  return {
    ok: false,
    code,
    details: { domain_code: code },
  }
}
