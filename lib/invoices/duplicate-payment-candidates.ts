import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DUPLICATE_AMOUNT_TOLERANCE_PCT,
  DUPLICATE_DATE_WINDOW_DAYS,
  escapeLikePattern,
  normalizeOcrReference,
} from './duplicate-payment-guard'

export type DuplicatePaymentMatchReason =
  | 'ocr_exact'
  | 'name_amount_fuzzy'
  | 'amount_only'

export interface DuplicatePaymentCandidate {
  id: string
  date: string
  amount: number
  description: string | null
  merchant_name: string | null
  reference: string | null
  match_reason: DuplicatePaymentMatchReason
  match_confidence: number
}

const MATCH_REASON_RANK: Record<DuplicatePaymentMatchReason, number> = {
  ocr_exact: 0,
  name_amount_fuzzy: 1,
  amount_only: 2,
}

const MATCH_REASON_CONFIDENCE: Record<DuplicatePaymentMatchReason, number> = {
  ocr_exact: 0.99,
  name_amount_fuzzy: 0.7,
  amount_only: 0.5,
}

interface CustomerInvoice {
  invoice_number: string | null
  customer_name: string | null | undefined
}

type Row = {
  id: string
  date: string
  amount: number
  description: string | null
  merchant_name: string | null
  reference: string | null
}

/**
 * Scan unlinked positive (inbound) business bank transactions that could be
 * the payment for this customer invoice. Used by the mark-paid duplicate
 * guard: callers route the user to "link existing" instead of double-booking.
 *
 * Customer-side adaptations vs the supplier guard:
 *  - amount > 0 (inbound) instead of < 0
 *  - matches BOTH `merchant_name` AND `description` (banks often describe an
 *    inbound payment by payer name without populating merchant_name)
 *  - per-candidate scoring with OCR (invoice_number normalized) as the
 *    strongest signal
 *
 * The merchant_name and description searches are issued as two separate
 * parameterised `.ilike()` queries and deduplicated by id. We deliberately
 * avoid `.or('merchant_name.ilike.%X%,description.ilike.%X%')` because that
 * interpolates the customer name into PostgREST's filter-DSL string, where
 * `escapeLikePattern` only neutralises the LIKE wildcards (`%_\\`) and not
 * the DSL chars (`,`, `.`, `(`, `)`). A name like `Acme,fake.eq.true` would
 * otherwise inject a synthetic filter clause.
 */
export async function findDuplicatePaymentCandidatesForInvoice(
  supabase: SupabaseClient,
  params: {
    companyId: string
    invoice: CustomerInvoice
    paymentAmount: number
    paymentDate: string
  },
): Promise<DuplicatePaymentCandidate[]> {
  const { companyId, invoice, paymentAmount, paymentDate } = params
  const customerName = invoice.customer_name
  if (!customerName) return []

  const windowLow = Math.round(paymentAmount * (1 - DUPLICATE_AMOUNT_TOLERANCE_PCT) * 100) / 100
  const windowHigh = Math.round(paymentAmount * (1 + DUPLICATE_AMOUNT_TOLERANCE_PCT) * 100) / 100
  const dateMs = new Date(paymentDate).getTime()
  const dateLow = new Date(dateMs - DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0]
  const dateHigh = new Date(dateMs + DUPLICATE_DATE_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .split('T')[0]
  const pattern = `%${escapeLikePattern(customerName)}%`

  const base = () =>
    supabase
      .from('transactions')
      .select('id, date, amount, description, merchant_name, reference')
      .eq('company_id', companyId)
      .eq('is_business', true)
      .is('invoice_id', null)
      .is('supplier_invoice_id', null)
      .gt('amount', 0)
      .gte('amount', windowLow)
      .lte('amount', windowHigh)
      .gte('date', dateLow)
      .lte('date', dateHigh)

  const [byMerchantRes, byDescriptionRes] = await Promise.all([
    base().ilike('merchant_name', pattern).order('date', { ascending: false }).limit(5),
    base().ilike('description', pattern).order('date', { ascending: false }).limit(5),
  ])

  const merged = new Map<string, Row>()
  for (const row of (byMerchantRes.data ?? []) as Row[]) merged.set(row.id, row)
  for (const row of (byDescriptionRes.data ?? []) as Row[]) {
    if (!merged.has(row.id)) merged.set(row.id, row)
  }
  const data = Array.from(merged.values())
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 5)

  if (data.length === 0) return []

  const invoiceOcr = normalizeOcrReference(invoice.invoice_number)
  const searchTerms = customerName
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2)

  const candidates: DuplicatePaymentCandidate[] = data.map((row) => {
    const reason = scoreCandidate({
      row,
      invoiceOcr,
      searchTerms,
    })
    return {
      id: row.id,
      date: row.date,
      amount: row.amount,
      description: row.description,
      merchant_name: row.merchant_name,
      reference: row.reference,
      match_reason: reason,
      match_confidence: MATCH_REASON_CONFIDENCE[reason],
    }
  })

  candidates.sort((a, b) => MATCH_REASON_RANK[a.match_reason] - MATCH_REASON_RANK[b.match_reason])
  return candidates
}

function scoreCandidate(args: {
  row: { reference: string | null; description: string | null; merchant_name: string | null }
  invoiceOcr: string
  searchTerms: string[]
}): DuplicatePaymentMatchReason {
  const { row, invoiceOcr, searchTerms } = args
  if (invoiceOcr && row.reference) {
    if (normalizeOcrReference(row.reference) === invoiceOcr) {
      return 'ocr_exact'
    }
  }
  if (searchTerms.length > 0) {
    const haystack = `${row.description ?? ''} ${row.merchant_name ?? ''}`.toLowerCase()
    if (searchTerms.some((term) => haystack.includes(term))) {
      return 'name_amount_fuzzy'
    }
  }
  return 'amount_only'
}
