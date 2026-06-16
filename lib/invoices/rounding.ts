import type { Invoice, CompanySettings } from '@/types'

type InvoiceTotalShape = Pick<Invoice, 'total' | 'currency'>
type CompanyRoundingShape = Pick<CompanySettings, 'ore_rounding'>

export interface DisplayTotal {
  /** Total to render to the user (rounded if öresavrundning applies, raw otherwise). */
  displayed: number
  /** displayed - raw total. Zero when rounding does not apply or the total is already an integer. */
  roundingDelta: number
  /** True when both the company setting is on, currency is SEK, and there are öre to round. */
  applies: boolean
}

/**
 * Single source of truth for öresavrundning display logic. Mirrors the rule
 * baked into the PDF template since day one: only SEK invoices, only when
 * the company has the setting enabled, and only when there's actually a
 * non-integer total to round. The helper centralizes the rule so the list,
 * detail page, and PDF cannot drift apart.
 */
export function getDisplayTotal(
  invoice: InvoiceTotalShape,
  company: CompanyRoundingShape | null | undefined,
): DisplayTotal {
  const enabled = company?.ore_rounding ?? true
  if (!enabled || invoice.currency !== 'SEK') {
    return { displayed: invoice.total, roundingDelta: 0, applies: false }
  }
  const rounded = Math.round(invoice.total)
  if (rounded === invoice.total) {
    return { displayed: invoice.total, roundingDelta: 0, applies: false }
  }
  return {
    displayed: rounded,
    roundingDelta: Math.round((rounded - invoice.total) * 100) / 100,
    applies: true,
  }
}
