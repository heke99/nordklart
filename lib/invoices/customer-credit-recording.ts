import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'

export interface RecordCustomerOverpaymentInput {
  userId: string
  companyId: string
  customerId: string | null
  invoiceId: string
  paymentId: string | null
  transactionId?: string | null
  journalEntryId?: string | null
  amount: number
  currency: string
  notes?: string | null
}

export async function recordCustomerOverpayment(
  supabase: SupabaseClient,
  input: RecordCustomerOverpaymentInput,
): Promise<{ creditId: string | null }> {
  const amount = roundOre(input.amount)
  if (amount <= 0) return { creditId: null }

  const { data: credit, error: creditError } = await supabase
    .from('customer_account_credits')
    .insert({
      user_id: input.userId,
      company_id: input.companyId,
      customer_id: input.customerId,
      source_invoice_id: input.invoiceId,
      source_payment_id: input.paymentId,
      source_transaction_id: input.transactionId ?? null,
      source_journal_entry_id: input.journalEntryId ?? null,
      amount,
      remaining_amount: amount,
      currency: input.currency,
      status: 'open',
      reason: 'overpayment',
      notes: input.notes ?? 'Överbetalning registrerad som kundsaldo.',
    })
    .select('id')
    .single()

  if (creditError) throw creditError

  const creditId = (credit as { id?: string } | null)?.id ?? null

  const { error: adjustmentError } = await supabase
    .from('invoice_payment_adjustments')
    .insert({
      user_id: input.userId,
      company_id: input.companyId,
      invoice_id: input.invoiceId,
      payment_id: input.paymentId,
      transaction_id: input.transactionId ?? null,
      customer_credit_id: creditId,
      journal_entry_id: input.journalEntryId ?? null,
      adjustment_type: 'overpayment',
      amount,
      currency: input.currency,
      status: 'open',
      notes: input.notes ?? 'Överbetalning registrerad som kundsaldo.',
    })

  if (adjustmentError) throw adjustmentError
  return { creditId }
}

export interface RecordInvoicePaymentDifferenceInput {
  userId: string
  companyId: string
  invoiceId: string
  paymentId: string | null
  transactionId?: string | null
  journalEntryId?: string | null
  amount: number
  currency: string
  notes?: string | null
}

export async function recordInvoiceUnderpayment(
  supabase: SupabaseClient,
  input: RecordInvoicePaymentDifferenceInput,
): Promise<void> {
  const amount = roundOre(input.amount)
  if (amount <= 0) return

  const { error } = await supabase
    .from('invoice_payment_adjustments')
    .insert({
      user_id: input.userId,
      company_id: input.companyId,
      invoice_id: input.invoiceId,
      payment_id: input.paymentId,
      transaction_id: input.transactionId ?? null,
      journal_entry_id: input.journalEntryId ?? null,
      adjustment_type: 'underpayment',
      amount,
      currency: input.currency,
      status: 'open',
      notes: input.notes ?? 'Restbelopp kvar efter delbetalning.',
    })

  if (error) throw error
}
