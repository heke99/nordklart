import type { CreateJournalEntryLineInput } from '@/types'
import { roundOre } from '@/lib/money'

export const CUSTOMER_CREDIT_ACCOUNT = '2420'

export function buildInvoicePaymentWithCustomerCreditLines({
  bankAmount,
  invoiceSettlementAmount,
  customerCreditAmount,
  description,
}: {
  bankAmount: number
  invoiceSettlementAmount: number
  customerCreditAmount: number
  description: string
}): CreateJournalEntryLineInput[] {
  const bank = roundOre(bankAmount)
  const settlement = roundOre(invoiceSettlementAmount)
  const credit = roundOre(customerCreditAmount)
  const creditTotal = roundOre(settlement + credit)

  if (Math.abs(bank - creditTotal) > 0.005) {
    throw new Error(
      `Customer overpayment journal does not balance: debit ${bank}, credit ${creditTotal}`,
    )
  }

  const lines: CreateJournalEntryLineInput[] = [
    {
      account_number: '1930',
      debit_amount: bank,
      credit_amount: 0,
      line_description: description,
    },
  ]

  if (settlement > 0) {
    lines.push({
      account_number: '1510',
      debit_amount: 0,
      credit_amount: settlement,
      line_description: `${description} – reglerar kundfordran`,
    })
  }

  if (credit > 0) {
    lines.push({
      account_number: CUSTOMER_CREDIT_ACCOUNT,
      debit_amount: 0,
      credit_amount: credit,
      line_description: `${description} – överbetalning/kundsaldo`,
    })
  }

  return lines
}
