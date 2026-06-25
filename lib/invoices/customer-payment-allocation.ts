import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import type { Invoice } from '@/types'

export interface CustomerPaymentAllocationPlan {
  appliedAmount: number
  overpaymentAmount: number
  newPaidAmount: number
  newRemaining: number
  isFullyPaid: boolean
  newStatus: 'paid' | 'partially_paid'
  previousRemaining: number
}

export function getInvoiceOpenAmount(invoice: Pick<Invoice, 'total' | 'paid_amount' | 'remaining_amount'>): number {
  return roundOre(
    invoice.remaining_amount != null
      ? invoice.remaining_amount
      : invoice.total - (invoice.paid_amount ?? 0),
  )
}

/**
 * Allocates a customer receipt against an invoice while preserving an explicit
 * customer-credit amount when the receipt is larger than the invoice balance.
 * Amounts are expressed in the invoice currency.
 */
export function planInvoiceCustomerPayment(
  invoice: Pick<Invoice, 'total' | 'paid_amount' | 'remaining_amount'>,
  paymentAmount: number,
): CustomerPaymentAllocationPlan {
  const previousRemaining = Math.max(0, getInvoiceOpenAmount(invoice))
  const roundedPayment = roundOre(paymentAmount)

  if (roundedPayment <= ORE_TOLERANCE) {
    return {
      appliedAmount: 0,
      overpaymentAmount: 0,
      newPaidAmount: roundOre(invoice.paid_amount ?? 0),
      newRemaining: previousRemaining,
      isFullyPaid: previousRemaining <= ORE_TOLERANCE,
      newStatus: previousRemaining <= ORE_TOLERANCE ? 'paid' : 'partially_paid',
      previousRemaining,
    }
  }

  const appliedAmount = roundOre(Math.min(roundedPayment, previousRemaining))
  const overpaymentAmount = roundedPayment > previousRemaining + ORE_TOLERANCE
    ? roundOre(roundedPayment - previousRemaining)
    : 0
  const newRemaining = Math.max(0, roundOre(previousRemaining - appliedAmount))
  const newPaidAmount = roundOre((invoice.paid_amount ?? 0) + appliedAmount)
  const isFullyPaid = newRemaining <= ORE_TOLERANCE

  return {
    appliedAmount,
    overpaymentAmount,
    newPaidAmount,
    newRemaining,
    isFullyPaid,
    newStatus: isFullyPaid ? 'paid' : 'partially_paid',
    previousRemaining,
  }
}
