/**
 * Supplier Invoice Matching — auto-match expense transactions to unpaid supplier invoices.
 *
 * 4-pass matching algorithm (ordered by confidence):
 * 1. Payment reference/OCR exact match → 0.98
 * 2. Exact amount + bankgiro/plusgiro match → 0.92
 * 3. Exact amount + date ±5 days → 0.85
 * 4. Fuzzy amount (±0.01) + supplier name in description → 0.70
 *
 * Auto-match threshold: ≥0.85 → applied automatically
 * Suggestion threshold: 0.70–0.85 → stored as potential_supplier_invoice_id
 */

import type { Transaction, SupplierInvoice } from '@/types'

export interface SupplierInvoiceMatch {
  supplierInvoice: SupplierInvoice
  confidence: number
  matchMethod: 'payment_reference' | 'amount_bankgiro' | 'amount_date' | 'fuzzy_name'
}

/**
 * Normalize payment reference for comparison (strip whitespace and non-digits).
 */
function normalizeReference(ref: string): string {
  return ref.replace(/\D/g, '')
}

/**
 * Find the best matching supplier invoice for an expense transaction.
 * Expects invoices to have the `supplier` relation populated (for name/bankgiro matching).
 * Only matches against invoices with status 'registered' or 'approved'
 * and with remaining_amount > 0.
 */
export function findSupplierInvoiceMatch(
  transaction: Transaction,
  unpaidInvoices: SupplierInvoice[]
): SupplierInvoiceMatch | null {
  if (unpaidInvoices.length === 0) return null

  // Only match expense transactions
  const txAmount = Math.abs(transaction.amount)
  if (txAmount === 0) return null

  let bestMatch: SupplierInvoiceMatch | null = null

  for (const invoice of unpaidInvoices) {
    // Only match against registered/approved invoices with remaining amount
    if (!['registered', 'approved'].includes(invoice.status)) continue
    const remaining = invoice.remaining_amount ?? invoice.total
    if (remaining <= 0) continue

    // Pass 1: Payment reference/OCR exact match → 0.98
    if (transaction.reference && invoice.payment_reference) {
      const txRef = normalizeReference(transaction.reference)
      const invRef = normalizeReference(invoice.payment_reference)
      if (txRef && invRef && txRef === invRef) {
        return {
          supplierInvoice: invoice,
          confidence: 0.98,
          matchMethod: 'payment_reference',
        }
      }
    }

    // Pass 2: Exact amount + bankgiro/plusgiro match → 0.92
    const amountMatch = Math.abs(txAmount - remaining) < 0.005
    if (amountMatch) {
      const txDesc = (transaction.description || '').toLowerCase()
      const supplierBg = invoice.supplier?.bankgiro
      const supplierPg = invoice.supplier?.plusgiro
      const bgMatch = supplierBg && txDesc.includes(normalizeReference(supplierBg))
      const pgMatch = supplierPg && txDesc.includes(normalizeReference(supplierPg))

      if (bgMatch || pgMatch) {
        return {
          supplierInvoice: invoice,
          confidence: 0.92,
          matchMethod: 'amount_bankgiro',
        }
      }
    }

    // Pass 3: Exact amount + date ±5 days → 0.85
    if (amountMatch && invoice.due_date) {
      const txDate = new Date(transaction.date)
      const dueDate = new Date(invoice.due_date)
      const diffDays = Math.abs((txDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))

      if (diffDays <= 5) {
        const confidence = 0.85
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = {
            supplierInvoice: invoice,
            confidence,
            matchMethod: 'amount_date',
          }
        }
      }
    }

    // Pass 4: Fuzzy amount (±5 SEK) + supplier name in description → 0.70
    // Tolerance covers öresavrundning and minor fee differences
    const fuzzyAmountMatch = Math.abs(txAmount - remaining) <= 5.00
    const supplierName = invoice.supplier?.name
    if (fuzzyAmountMatch && supplierName) {
      const txDesc = (transaction.description || '').toLowerCase()
      const normalizedName = supplierName.toLowerCase()

      // Check if any significant word from the supplier name appears in the description
      const nameWords = normalizedName
        .replace(/[^\w\såäöé]/g, '')
        .split(/\s+/)
        .filter((w) => w.length >= 3)

      const nameInDesc = nameWords.some((word) => txDesc.includes(word))

      if (nameInDesc) {
        const confidence = 0.70
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = {
            supplierInvoice: invoice,
            confidence,
            matchMethod: 'fuzzy_name',
          }
        }
      }
    }
  }

  return bestMatch
}
