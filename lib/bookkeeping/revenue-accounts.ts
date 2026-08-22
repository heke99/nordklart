/**
 * BAS account selection for sales revenue and output VAT.
 *
 * Deliberately dependency-free: these two lookups are pure switch statements,
 * but they used to live in `invoice-entries.ts`, which imports the bookkeeping
 * engine — and the engine imports `@/lib/supabase/server`, which imports
 * `next/headers`. The client-side preview modules (`propose-send-lines.ts`,
 * `propose-payment-lines.ts`) need only these lookups, so importing them from
 * `invoice-entries.ts` dragged the entire server-only engine into the browser
 * bundle and failed the build. Keep this module free of imports other than
 * types.
 */
import type { EntityType, SaleType, VatTreatment } from '@/types'

/**
 * Get the appropriate revenue account based on VAT treatment.
 *
 * For 'exempt': AB uses 3004 (Försäljning inom Sverige, momsfri),
 * EF uses 3100 (Momsfria intäkter, mapped to R2 in NE engine).
 *
 * Zero-rated sales discriminate goods vs services (ML 6 kap):
 *   reverse_charge + goods    → 3108 (Försäljning varor EU, ruta 35)
 *   reverse_charge + services → 3308 (Försäljning tjänster EU, ruta 39)
 *   export + goods            → 3105 (Försäljning varor export, ruta 36)
 *   export + services         → 3305 (Försäljning tjänster export, ruta 40)
 * Default 'services' preserves the historical booking for legacy rows.
 */
export function getRevenueAccount(
  vatTreatment: VatTreatment,
  entityType: EntityType = 'enskild_firma',
  saleType: SaleType = 'services',
): string {
  switch (vatTreatment) {
    case 'standard_25':
      return '3001' // Försäljning 25%
    case 'reduced_12':
      return '3002' // Försäljning 12%
    case 'reduced_6':
      return '3003' // Försäljning 6%
    case 'reverse_charge':
      return saleType === 'goods' ? '3108' : '3308' // Varor EU (ruta 35) / Tjänster EU (ruta 39)
    case 'export':
      return saleType === 'goods' ? '3105' : '3305' // Varor export (ruta 36) / Tjänster export (ruta 40)
    case 'exempt':
      return entityType === 'aktiebolag' ? '3004' : '3100'
    default:
      return '3001'
  }
}

/**
 * Get the output VAT account based on VAT treatment
 */
export function getOutputVatAccount(vatTreatment: VatTreatment): string {
  switch (vatTreatment) {
    case 'standard_25':
      return '2611'
    case 'reduced_12':
      return '2621'
    case 'reduced_6':
      return '2631'
    default:
      return '2611'
  }
}
