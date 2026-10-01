import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'

/**
 * Booking proposal for a supplier invoice: which expense account each line
 * should be debited, learned from how the company booked the same supplier
 * before. No model is involved, so the same input always gives the same
 * proposal, and nothing is invented: without history or a default account
 * for the supplier there is no proposal and the user picks the account.
 *
 * Priority per VAT rate:
 *   1. history          — the account used most often on this supplier's
 *                         earlier invoices at the same VAT rate
 *   2. history_any_rate — the account used most often for the supplier at any rate
 *   3. supplier_default — suppliers.default_expense_account
 */

export type ProposalSource = 'history' | 'history_any_rate' | 'supplier_default'

export interface AccountSuggestion {
  /** Most used account per VAT rate as a decimal string ('0.25', '0.12', …). */
  byVatRate: Record<string, string>
  /** Most used account overall, or the supplier's default account. */
  primary: string | null
  primarySource: ProposalSource | null
  /** Earlier invoice lines the history is based on. */
  historyLines: number
  supplier: { name: string; supplierType: string | null; defaultPaymentTerms: number | null } | null
}

/** Invoices whose lines reflect a booking the company stood behind. */
const BOOKED_STATUSES = ['registered', 'approved', 'paid', 'partially_paid', 'overdue']
const HISTORY_LIMIT = 200

function rateKey(rate: number | string | null | undefined): string {
  const n = Number(rate ?? 0)
  return (Math.round(n * 100) / 100).toFixed(2)
}

function mostUsed(counts: Map<string, { n: number; latest: number }>): string | null {
  let best: string | null = null
  let bestN = -1
  let bestLatest = -1
  for (const [account, { n, latest }] of counts) {
    if (n > bestN || (n === bestN && latest > bestLatest)) {
      best = account
      bestN = n
      bestLatest = latest
    }
  }
  return best
}

export async function suggestAccountsForSupplier(
  supabase: SupabaseClient,
  companyId: string,
  supplierId: string,
): Promise<AccountSuggestion> {
  const [{ data: supplier }, { data: lines }] = await Promise.all([
    supabase
      .from('suppliers')
      .select('name, supplier_type, default_payment_terms, default_expense_account')
      .eq('id', supplierId)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('supplier_invoice_items')
      .select('account_number, vat_rate, supplier_invoices!inner(company_id, supplier_id, status, invoice_date)')
      .eq('supplier_invoices.company_id', companyId)
      .eq('supplier_invoices.supplier_id', supplierId)
      .in('supplier_invoices.status', BOOKED_STATUSES)
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT),
  ])

  const perRate = new Map<string, Map<string, { n: number; latest: number }>>()
  const overall = new Map<string, { n: number; latest: number }>()
  const rows = (lines ?? []) as Array<{ account_number: string; vat_rate: number; supplier_invoices: { invoice_date: string } | { invoice_date: string }[] }>
  for (const row of rows) {
    if (!/^[4-7]\d{3}$/.test(row.account_number ?? '')) continue
    const parent = Array.isArray(row.supplier_invoices) ? row.supplier_invoices[0] : row.supplier_invoices
    const latest = Date.parse(parent?.invoice_date ?? '') || 0
    const key = rateKey(row.vat_rate)
    const bucket = perRate.get(key) ?? new Map()
    for (const map of [bucket, overall]) {
      const prev = map.get(row.account_number)
      map.set(row.account_number, { n: (prev?.n ?? 0) + 1, latest: Math.max(prev?.latest ?? 0, latest) })
    }
    perRate.set(key, bucket)
  }

  const byVatRate: Record<string, string> = {}
  for (const [key, counts] of perRate) {
    const account = mostUsed(counts)
    if (account) byVatRate[key] = account
  }
  const historyPrimary = mostUsed(overall)
  const defaultAccount = (supplier?.default_expense_account as string | null) ?? null

  return {
    byVatRate,
    primary: historyPrimary ?? defaultAccount,
    primarySource: historyPrimary ? 'history_any_rate' : defaultAccount ? 'supplier_default' : null,
    historyLines: rows.length,
    supplier: supplier
      ? {
          name: supplier.name as string,
          supplierType: (supplier.supplier_type as string | null) ?? null,
          defaultPaymentTerms: (supplier.default_payment_terms as number | null) ?? null,
        }
      : null,
  }
}

export interface ProposalLineInput {
  description: string
  amount: number
  /** Decimal VAT rate (0.25). */
  vatRate: number
}

export interface ProposedLine extends ProposalLineInput {
  accountNumber: string | null
  source: ProposalSource | null
}

/** Attach the suggested account to each line; lines without one keep accountNumber null. */
export function applySuggestion(lines: ProposalLineInput[], suggestion: AccountSuggestion): ProposedLine[] {
  return lines.map((line) => {
    const exact = suggestion.byVatRate[rateKey(line.vatRate)]
    if (exact) return { ...line, amount: roundOre(line.amount), accountNumber: exact, source: 'history' }
    return {
      ...line,
      amount: roundOre(line.amount),
      accountNumber: suggestion.primary,
      source: suggestion.primary ? suggestion.primarySource : null,
    }
  })
}

/** A proposal can be approved as is only when every line has an account. */
export function proposalIsComplete(lines: ProposedLine[]): boolean {
  return lines.length > 0 && lines.every((l) => !!l.accountNumber)
}

export type QuickApproveBlocker =
  | 'incomplete_accounts'
  | 'missing_invoice_number'
  | 'missing_dates'
  | 'foreign_supplier'
  | 'foreign_currency'
  | 'representation'
  | 'totals_mismatch'

/**
 * Whether a proposal may be registered with one click, or must be opened in
 * the editor. One click is limited to plain domestic invoices; reverse charge
 * (EU and non-EU suppliers), foreign currency and representation (ML 13 kap.
 * 27 §, number of participants) need details the proposal cannot supply.
 */
export function quickApproveBlockers(input: {
  lines: ProposedLine[]
  supplierType: string | null
  currency: string | null
  invoiceNumber: string | null
  invoiceDate: string | null
  dueDate: string | null
  extractedTotal: number | null
}): QuickApproveBlocker[] {
  const blockers: QuickApproveBlocker[] = []
  if (!proposalIsComplete(input.lines)) blockers.push('incomplete_accounts')
  if (!input.invoiceNumber) blockers.push('missing_invoice_number')
  if (!input.invoiceDate || !input.dueDate) blockers.push('missing_dates')
  if (input.supplierType && input.supplierType !== 'swedish_business' && input.supplierType !== 'individual') {
    blockers.push('foreign_supplier')
  }
  if (input.currency && input.currency !== 'SEK') blockers.push('foreign_currency')
  if (input.lines.some((l) => /^607\d$/.test(l.accountNumber ?? ''))) blockers.push('representation')
  if (input.extractedTotal != null) {
    const computed = roundOre(input.lines.reduce((sum, l) => sum + l.amount * (1 + l.vatRate), 0))
    if (Math.abs(computed - input.extractedTotal) > 1) blockers.push('totals_mismatch')
  } else {
    blockers.push('totals_mismatch')
  }
  return blockers
}
