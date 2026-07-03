import type { Customer, Invoice } from '@/types'

/**
 * Eligibility rules for offering a customer invoice for financing.
 * Pure — unit-testable without I/O. Swedish, actionable messages.
 */

export interface EligibilityIssue {
  code: string
  message_sv: string
}

export interface EligibilityInput {
  invoice: Pick<
    Invoice,
    'status' | 'total' | 'remaining_amount' | 'currency' | 'due_date' | 'credited_invoice_id' | 'invoice_number'
  > & { deduction_total?: number }
  customer: Pick<Customer, 'name' | 'org_number' | 'customer_type'> | null
  provider: { min_amount: number; max_amount: number | null }
  /** Days into the future the due date may lie (default 90). */
  maxDueDays?: number
  today?: Date
}

export function checkFinancingEligibility(input: EligibilityInput): EligibilityIssue[] {
  const issues: EligibilityIssue[] = []
  const { invoice, customer, provider } = input
  const today = input.today ?? new Date()
  const maxDueDays = input.maxDueDays ?? 90

  if (!invoice.invoice_number) {
    issues.push({ code: 'NOT_ISSUED', message_sv: 'Fakturan är inte utställd (saknar fakturanummer).' })
  }
  if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
    issues.push({
      code: 'INVALID_STATUS',
      message_sv: `Endast skickade obetalda fakturor kan finansieras (status: ${invoice.status}).`,
    })
  }
  if (invoice.credited_invoice_id) {
    issues.push({ code: 'IS_CREDIT_NOTE', message_sv: 'Kreditfakturor kan inte finansieras.' })
  }
  if (invoice.remaining_amount < invoice.total - (invoice.deduction_total ?? 0)) {
    issues.push({
      code: 'PARTIALLY_PAID',
      message_sv: 'Fakturan är delbetald — endast helt obetalda fakturor kan finansieras.',
    })
  }
  if (invoice.currency !== 'SEK') {
    issues.push({ code: 'CURRENCY', message_sv: 'Endast fakturor i SEK kan finansieras.' })
  }
  if ((invoice.deduction_total ?? 0) > 0) {
    issues.push({
      code: 'ROT_RUT',
      message_sv: 'Fakturor med ROT/RUT-avdrag kan inte finansieras (Skatteverket betalar en del av beloppet).',
    })
  }
  if (invoice.total < provider.min_amount) {
    issues.push({
      code: 'BELOW_MINIMUM',
      message_sv: `Fakturabeloppet (${invoice.total.toLocaleString('sv-SE')} kr) understiger finansiärens minimibelopp (${provider.min_amount.toLocaleString('sv-SE')} kr).`,
    })
  }
  if (provider.max_amount != null && invoice.total > provider.max_amount) {
    issues.push({
      code: 'ABOVE_MAXIMUM',
      message_sv: `Fakturabeloppet överstiger finansiärens maxbelopp (${provider.max_amount.toLocaleString('sv-SE')} kr).`,
    })
  }

  // Due date must be in the future-ish window: not more than maxDueDays
  // ahead, and not severely overdue (> 30 days past due is a credit risk
  // most providers refuse).
  const due = new Date(`${invoice.due_date}T00:00:00Z`)
  const diffDays = Math.floor((due.getTime() - today.getTime()) / 86_400_000)
  if (diffDays > maxDueDays) {
    issues.push({
      code: 'DUE_TOO_FAR',
      message_sv: `Förfallodatumet ligger mer än ${maxDueDays} dagar fram — finansiären accepterar inte så långa kredittider.`,
    })
  }
  if (diffDays < -30) {
    issues.push({
      code: 'SEVERELY_OVERDUE',
      message_sv: 'Fakturan är förfallen sedan mer än 30 dagar — den kan inte finansieras.',
    })
  }

  if (!customer) {
    issues.push({ code: 'CUSTOMER_MISSING', message_sv: 'Kunduppgifter saknas.' })
  } else {
    if (customer.customer_type === 'individual') {
      issues.push({ code: 'B2C', message_sv: 'Endast företagsfakturor (B2B) kan finansieras.' })
    }
    if (!customer.org_number?.trim()) {
      issues.push({
        code: 'CUSTOMER_ORG_MISSING',
        message_sv: 'Kundens organisationsnummer saknas — komplettera kundkortet (krävs för kreditprövning).',
      })
    }
  }

  return issues
}
