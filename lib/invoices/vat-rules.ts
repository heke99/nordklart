import type { CustomerType, SaleType, VatTreatment } from '@/types'
import { BOX_LABELS, type MomsBox } from '@/lib/vat/moms-box-mapping'

export interface VatRateOption {
  rate: number
  label: string
  treatment: VatTreatment
}

/**
 * Get available VAT rates for invoice line items based on customer type.
 *
 * Swedish/EU-unvalidated customers can choose between 25%, 12%, 6%, and 0% (exempt).
 * Reverse charge and export customers are locked to 0%.
 *
 * The picker does NOT gate on the seller's VAT registration status. A
 * non-momsregistrerad seller is shown the same options as a registered one —
 * the form surfaces a warning at submit time (ML 16 kap. 23 § faktureringsmoms:
 * stated VAT is owed even by non-registered sellers, but the buyer cannot
 * deduct it as input VAT).
 */
export function getAvailableVatRates(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
): VatRateOption[] {
  // EU business with validated VAT → reverse charge, locked to 0%
  if (customerType === 'eu_business' && vatNumberValidated) {
    return [{ rate: 0, label: '0% (omvänd skattskyldighet)', treatment: 'reverse_charge' }]
  }

  // Non-EU → export, locked to 0%
  if (customerType === 'non_eu_business') {
    return [{ rate: 0, label: '0% (export)', treatment: 'export' }]
  }

  // Swedish customers (or EU without validated VAT) can choose any rate
  return [
    { rate: 25, label: '25%', treatment: 'standard_25' },
    { rate: 12, label: '12%', treatment: 'reduced_12' },
    { rate: 6, label: '6%', treatment: 'reduced_6' },
    { rate: 0, label: '0% (momsfritt)', treatment: 'exempt' },
  ]
}

/**
 * Map a numeric VAT rate to a VatTreatment.
 */
export function getVatTreatmentForRate(rate: number): VatTreatment {
  switch (rate) {
    case 25:
      return 'standard_25'
    case 12:
      return 'reduced_12'
    case 6:
      return 'reduced_6'
    case 0:
      return 'exempt'
    default:
      return 'standard_25'
  }
}

export interface VatRule {
  treatment: VatTreatment
  rate: number
  momsRuta: string
  reverseChargeText?: string
}

/**
 * Determine VAT treatment based on customer type, VAT validation status,
 * and whether the sale is goods or services.
 *
 * Rules:
 * - Swedish customers: 25% VAT, moms ruta 05
 * - EU business with validated VAT: 0% reverse charge —
 *     services → ruta 39 (Art. 196, huvudregeln), goods → ruta 35
 *     (unionsintern försäljning, Art. 138)
 * - EU business without validated VAT: 25% VAT, moms ruta 05
 * - Non-EU business: 0% export — services → ruta 40, goods → ruta 36
 *
 * Independent of the seller's VAT registration status. A non-momsregistrerad
 * seller who charges VAT still owes it under ML 16 kap. 23 § (faktureringsmoms),
 * so the rule output must reflect the rate actually charged on the line.
 */
export function getVatRules(
  customerType: CustomerType,
  vatNumberValidated: boolean = false,
  saleType: SaleType = 'services',
): VatRule {
  switch (customerType) {
    case 'individual':
    case 'swedish_business':
      return {
        treatment: 'standard_25',
        rate: 25,
        momsRuta: '05',
      }

    case 'eu_business':
      if (vatNumberValidated) {
        return {
          treatment: 'reverse_charge',
          rate: 0,
          momsRuta: saleType === 'goods' ? '35' : '39',
          reverseChargeText: saleType === 'goods'
            ? 'Omvänd skattskyldighet / Intra-Community supply of goods, exempt per Article 138, Council Directive 2006/112/EC'
            : 'Omvänd skattskyldighet / Reverse charge - VAT to be accounted for by the recipient as per Article 196, Council Directive 2006/112/EC',
        }
      }
      // EU business without validated VAT number must be charged Swedish VAT
      return {
        treatment: 'standard_25',
        rate: 25,
        momsRuta: '05',
      }

    case 'non_eu_business':
      return {
        treatment: 'export',
        rate: 0,
        momsRuta: saleType === 'goods' ? '36' : '40',
        reverseChargeText: 'Omsättning utanför EU, ML 10 kap.',
      }

    default:
      return {
        treatment: 'standard_25',
        rate: 25,
        momsRuta: '05',
      }
  }
}

/**
 * Calculate VAT amount
 */
export function calculateVat(subtotal: number, vatRate: number): number {
  return Math.round(subtotal * vatRate) / 100
}

/**
 * Calculate total including VAT
 */
export function calculateTotal(subtotal: number, vatRate: number): number {
  return Math.round((subtotal + calculateVat(subtotal, vatRate)) * 100) / 100
}

/**
 * Format VAT rate for display
 */
export function formatVatRate(rate: number): string {
  if (rate === 0) {
    return '0%'
  }
  return `${rate}%`
}

/**
 * Get VAT treatment label in Swedish
 */
export function getVatTreatmentLabel(treatment: VatTreatment): string {
  const labels: Record<VatTreatment, string> = {
    standard_25: '25% moms',
    reduced_12: '12% moms',
    reduced_6: '6% moms',
    reverse_charge: 'Omvänd skattskyldighet (0%)',
    export: 'Export (0%)',
    exempt: 'Momsfritt',
  }
  return labels[treatment]
}

/**
 * Derive a display-friendly VAT summary from invoice line items.
 *
 * - If all items share a single rate → returns that rate's label and treatment
 * - If items have mixed rates → returns "Blandade momssatser" with null rate/treatment
 */
export function getVatSummaryFromItems(
  items: { vat_rate?: number | null }[]
): { label: string; treatment: VatTreatment | null; rate: number | null; isMixed: boolean } {
  const rates = new Set(items.map((item) => item.vat_rate ?? 0))

  if (rates.size === 1) {
    const rate = rates.values().next().value!
    const treatment = getVatTreatmentForRate(rate)
    return {
      label: getVatTreatmentLabel(treatment),
      treatment,
      rate,
      isMixed: false,
    }
  }

  return {
    label: 'Blandade momssatser',
    treatment: null,
    rate: null,
    isMixed: true,
  }
}

/**
 * Get the Swedish label for a momsdeklaration ruta (SKV 4700).
 *
 * Delegates to the canonical BOX_LABELS map in lib/vat/moms-box-mapping.ts.
 * Ruta 05/06/07 are TAXABLE SALES BASES (momspliktig försäljning / uttag /
 * vinstmarginalbeskattning) — output VAT lives on ruta 10/11/12.
 */
export function getMomsRutaDescription(ruta: string): string {
  return BOX_LABELS[ruta as MomsBox] || ruta
}
