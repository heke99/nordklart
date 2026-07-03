import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput, ReverseChargeType, VatTreatment } from '@/types'

/**
 * Generate VAT journal entry lines based on VAT treatment
 *
 * Swedish VAT scenarios:
 * - Domestic 25%: Credit 2611 (utgående moms)
 * - Domestic 12%: Credit 2621
 * - Domestic 6%: Credit 2631
 * - Input VAT deduction: Debit 2641 (ingående moms)
 * - EU reverse charge (fiktiv moms): Debit 2645, Credit 2614 (offsetting)
 * - Export (non-EU): No VAT lines
 */

interface VatEntryConfig {
  vatTreatment: VatTreatment
  baseAmount: number // Amount before VAT
  direction: 'sales' | 'purchase'
}

/**
 * Get VAT rate from treatment
 */
export function getVatRate(treatment: VatTreatment): number {
  switch (treatment) {
    case 'standard_25':
      return 0.25
    case 'reduced_12':
      return 0.12
    case 'reduced_6':
      return 0.06
    case 'reverse_charge':
    case 'export':
    case 'exempt':
      return 0
    default:
      return 0.25
  }
}

/**
 * Expense/basis accounts that already populate momsdeklaration ruta 20-24
 * directly when debited (the basbelopp for a reverse-charge purchase). If an RC
 * item is booked straight to one of these, the engine must NOT add the parallel
 * basbeloppsrader — that would double-count ruta 20-24.
 *
 *   ruta 20  EU goods             4515/4516/4517
 *   ruta 21  EU services          4535/4536/4537
 *   ruta 22  non-EU services      4531/4532/4533
 *   ruta 23  domestic goods RC    4415/4416/4417
 *   ruta 24  domestic services RC 4425/4426/4427
 */
export const RC_BASIS_ACCOUNTS: ReadonlySet<string> = new Set([
  '4515', '4516', '4517',
  '4535', '4536', '4537',
  '4531', '4532', '4533',
  '4415', '4416', '4417',
  '4425', '4426', '4427',
])

export function isReverseChargeBasisAccount(account: string): boolean {
  return RC_BASIS_ACCOUNTS.has(account)
}

/**
 * The self-assessed VAT rate to apply to a reverse-charge line.
 *
 * Under omvänd skattskyldighet the supplier charges no VAT, so the line's own
 * `vat_rate` is 0 (the v1 supplier-invoice API mandates this). The buyer must
 * still self-assess output + input VAT at the Swedish statutory rate that would
 * apply to the service domestically — 25% under huvudregeln for EU services
 * (ML 6 kap 34 §), 12%/6% for reduced-rated services. Resolution order:
 *
 *   1. explicit per-item `reverse_charge_rate` (the UI's self-assessment picker)
 *   2. a positive `vat_rate` on the line (legacy/API callers that encoded the
 *      self-assessment rate directly on vat_rate)
 *   3. 25% huvudregel default — never silently drop the fiktiv-moms lines.
 *
 * Keeping this in one place means the booking engine and the review-dialog
 * preview can never drift. The original bug was two independent copies of a
 * `rate > 0` assumption, each skipping the VAT entirely on a 0%-rate RC line.
 */
export function resolveReverseChargeRate(
  item: { vat_rate?: number | null; reverse_charge_rate?: number | null },
): number {
  const explicit = item.reverse_charge_rate
  if (explicit != null && explicit > 0) return explicit
  if (item.vat_rate != null && item.vat_rate > 0) return item.vat_rate
  return 0.25
}

/**
 * Generate output VAT lines for sales invoices
 * Debit 1510 Kundfordringar [total incl VAT]
 * Credit 30xx Försäljning [subtotal]
 * Credit 26xx Utgående moms [vat_amount]
 */
export function generateSalesVatLines(config: VatEntryConfig): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  const vatRate = getVatRate(config.vatTreatment)

  if (vatRate === 0) return lines

  const vatAmount = Math.round(config.baseAmount * vatRate * 100) / 100

  // Determine the output VAT account
  let vatAccount: string
  switch (config.vatTreatment) {
    case 'standard_25':
      vatAccount = '2611' // Utgående moms försäljning 25%
      break
    case 'reduced_12':
      vatAccount = '2621' // Utgående moms försäljning 12%
      break
    case 'reduced_6':
      vatAccount = '2631' // Utgående moms försäljning 6%
      break
    default:
      return lines
  }

  lines.push({
    account_number: vatAccount,
    debit_amount: 0,
    credit_amount: vatAmount,
    line_description: `Utgående moms ${vatRate * 100}%`,
  })

  return lines
}

/**
 * Generate reverse-charge basis lines for momsdeklaration ruta 20-24.
 *
 * The fiktiv-moms pair (2645/26x4 or 2647/26x4) only carries the VAT amounts
 * (ruta 30-32 and the offsetting part of ruta 48). The underlying basbelopp
 * (vad köpet de facto kostade) must also land on the 44xx/45xx series so
 * Skatteverket sees ruta 20-24 populated — ML 13 kap kräver att både underlag
 * och moms redovisas. SKV avvisar deklarationer med ruta 30-32 men tom 20-24
 * (felkod FK004 "Eftersom det finns ett belopp i någon momsuppgift som avser
 * utgående moms på inköp (30-32) måste det finnas ett belopp i någon av
 * momsuppgifterna avseende momspliktiga inköp vid omvänd betalningsskyldighet
 * (20-24)").
 *
 * Användarens valda kostnadskonto (t.ex. 6540) bibehålls i resultaträkningen
 * via en parallell motkonto-rad: 45xx debiteras, 4598 krediteras med samma
 * belopp. Resultaträkningen påverkas inte (4598 nettar ut 45xx), men 45xx
 * fångas av momsdeklarationsberäkningen för rätt ruta 20-24.
 *
 * Konto-mappning (BAS 2026 + swedish-vat reference §7):
 *
 *   EU services       (huvudregeln)  4535/4536/4537 → ruta 21
 *   Non-EU services                  4531/4532/4533 → ruta 22
 *   Domestic services (byggtjänster) 4425/4426/4427 → ruta 24
 *   Domestic goods    (RC varor)     4415/4416/4417 → ruta 23
 *
 * When `reverseChargeType` is supplied it takes precedence over the
 * supplier-country inference:
 *
 *   eu_goods     → 4515/4516/4517 (ruta 20, unionsinternt förvärv av varor)
 *   eu_services  → 4535/4536/4537 (ruta 21)
 *   construction → 4425/4426/4427 (ruta 24, byggtjänster ML 16 kap 13 §)
 *   electronics  → 4415/4416/4417 (ruta 23, ML 16 kap 17 §)
 *
 * Utan typ faller vi tillbaka på leverantörslandet (tjänster antas) — det
 * historiska beteendet för befintliga leverantörsfakturor.
 */
export function generateReverseChargeBasisLines(
  baseAmount: number,
  vatRate: number,
  supplierType: 'eu_business' | 'non_eu_business' | 'swedish_business',
  reverseChargeType?: ReverseChargeType | null,
): CreateJournalEntryLineInput[] {
  if (baseAmount <= 0) return []

  const basisAccount = pickBasisAccount(vatRate, supplierType, reverseChargeType)
  if (!basisAccount) return []

  const amount = Math.round(baseAmount * 100) / 100
  const rateLabel = `${Math.round(vatRate * 100)}%`

  return [
    {
      account_number: basisAccount.account,
      debit_amount: amount,
      credit_amount: 0,
      line_description: `${basisAccount.label} ${rateLabel} (basbelopp omvänd skattskyldighet)`,
    },
    {
      account_number: '4598',
      debit_amount: 0,
      credit_amount: amount,
      line_description: `Motkonto beräknad omvänd moms ${rateLabel}`,
    },
  ]
}

function pickBasisAccount(
  vatRate: number,
  supplierType: 'eu_business' | 'non_eu_business' | 'swedish_business',
  reverseChargeType?: ReverseChargeType | null,
): { account: string; label: string } | null {
  const rateIdx = vatRate === 0.25 ? 0 : vatRate === 0.12 ? 1 : vatRate === 0.06 ? 2 : -1
  if (rateIdx < 0) return null

  // Explicit classification wins over supplier-country inference.
  switch (reverseChargeType) {
    case 'eu_goods':
      return {
        account: ['4515', '4516', '4517'][rateIdx],
        label: 'Inköp varor annat EU-land',
      }
    case 'eu_services':
      return {
        account: ['4535', '4536', '4537'][rateIdx],
        label: 'Inköp tjänster annat EU-land',
      }
    case 'construction':
      return {
        account: ['4425', '4426', '4427'][rateIdx],
        label: 'Inköp tjänster i Sverige omvänd skattskyldighet',
      }
    case 'electronics':
      return {
        account: ['4415', '4416', '4417'][rateIdx],
        label: 'Inköp varor i Sverige omvänd skattskyldighet',
      }
    case 'import':
      // Import uses the importmoms path (basis 4545-4547 + output 2615/2625/
      // 2635), not the fiktiv-moms RC pair — handled by the import booking
      // flow. No 44xx/45xx basis lines here.
      return null
    default:
      break
  }

  if (supplierType === 'eu_business') {
    return {
      account: ['4535', '4536', '4537'][rateIdx],
      label: 'Inköp tjänster annat EU-land',
    }
  }
  if (supplierType === 'non_eu_business') {
    return {
      account: ['4531', '4532', '4533'][rateIdx],
      label: 'Inköp tjänster land utanför EU',
    }
  }
  // swedish_business — domestic RC (byggtjänster m.m.)
  return {
    account: ['4425', '4426', '4427'][rateIdx],
    label: 'Inköp tjänster i Sverige omvänd skattskyldighet',
  }
}

/**
 * Generate reverse charge lines (fiktiv moms)
 * For EU/non-EU purchases: Debit 2645 + Credit 26x4 (offsetting entries)
 * For domestic reverse charge: Debit 2647 + Credit 26x4 (offsetting entries)
 *
 * `vatRate` is REQUIRED and must be a Swedish statutory rate (0.25 / 0.12 /
 * 0.06). Callers that lack an explicit rate must resolve one first (see
 * resolveReverseChargeRate — 25% huvudregel). A silent fallback used to book
 * 25% fiktiv moms to 2614 for reduced-rate purchases, understating nothing
 * but mis-declaring rutor 30-32 — now we throw instead.
 */
export function generateReverseChargeLines(
  baseAmount: number,
  vatRate: number,
  isDomestic: boolean = false
): CreateJournalEntryLineInput[] {
  // Determine output account based on rate — throw on non-statutory rates.
  let outputAccount: string
  switch (vatRate) {
    case 0.25:
      outputAccount = '2614' // Utgående moms omvänd skattskyldighet 25%
      break
    case 0.12:
      outputAccount = '2624' // Utgående moms omvänd skattskyldighet 12%
      break
    case 0.06:
      outputAccount = '2634' // Utgående moms omvänd skattskyldighet 6%
      break
    default:
      throw new Error(
        `Ogiltig momssats för omvänd skattskyldighet: ${vatRate}. ` +
        'Tillåtna satser är 0.25, 0.12 och 0.06 (ML 6 kap 34 §).'
      )
  }

  const vatAmount = Math.round(baseAmount * vatRate * 100) / 100

  // Input VAT account: 2647 for domestic RC (ML 16 kap), 2645 for EU/non-EU
  const inputAccount = isDomestic ? '2647' : '2645'
  const context = isDomestic ? 'omvänd skattskyldighet i Sverige' : 'omvänd skattskyldighet'

  return [
    {
      account_number: inputAccount,
      debit_amount: vatAmount,
      credit_amount: 0,
      line_description: `Fiktiv ingående moms ${vatRate * 100}% (${context})`,
    },
    {
      account_number: outputAccount,
      debit_amount: 0,
      credit_amount: vatAmount,
      line_description: `Fiktiv utgående moms ${vatRate * 100}% (${context})`,
    },
  ]
}

/**
 * Generate import VAT lines (importmoms, since 2015 declared via the
 * momsdeklaration instead of paid to Tullverket for VAT-registered buyers).
 *
 *   Debit  2645 Beräknad ingående moms      [monetärt tullvärde × rate]
 *   Credit 2615/2625/2635 Utgående importmoms [same amount]
 *
 * Populates ruta 60/61/62 (output) and, via 2645, ruta 48 (input). The
 * beskattningsunderlag itself must be booked with generateImportBasisLines
 * so ruta 50 is populated — SKV cross-validates ruta 60 ≈ ruta 50 × 25%.
 */
export function generateImportVatLines(
  baseAmount: number,
  vatRate: number,
): CreateJournalEntryLineInput[] {
  let outputAccount: string
  switch (vatRate) {
    case 0.25: outputAccount = '2615'; break
    case 0.12: outputAccount = '2625'; break
    case 0.06: outputAccount = '2635'; break
    default:
      throw new Error(
        `Ogiltig momssats för importmoms: ${vatRate}. ` +
        'Tillåtna satser är 0.25, 0.12 och 0.06.'
      )
  }
  const vatAmount = roundOre(baseAmount * vatRate)
  const rateLabel = `${Math.round(vatRate * 100)}%`
  return [
    {
      account_number: '2645',
      debit_amount: vatAmount,
      credit_amount: 0,
      line_description: `Beräknad ingående moms import ${rateLabel}`,
    },
    {
      account_number: outputAccount,
      debit_amount: 0,
      credit_amount: vatAmount,
      line_description: `Utgående moms import ${rateLabel}`,
    },
  ]
}

/**
 * Generate import beskattningsunderlag lines for momsdeklaration ruta 50.
 *
 *   Debit  4545/4546/4547 Beskattningsunderlag import  [base]
 *   Credit 4598 Motkonto                                [base]
 *
 * Resultaträkningen påverkas inte (4598 nettar ut 454x); the 454x debit is
 * what the momsdeklaration reads for ruta 50. Same motkonto pattern as the
 * reverse-charge basbeloppsrader.
 */
export function generateImportBasisLines(
  baseAmount: number,
  vatRate: number,
): CreateJournalEntryLineInput[] {
  if (baseAmount <= 0) return []
  let basisAccount: string
  switch (vatRate) {
    case 0.25: basisAccount = '4545'; break
    case 0.12: basisAccount = '4546'; break
    case 0.06: basisAccount = '4547'; break
    default: return []
  }
  const amount = roundOre(baseAmount)
  const rateLabel = `${Math.round(vatRate * 100)}%`
  return [
    {
      account_number: basisAccount,
      debit_amount: amount,
      credit_amount: 0,
      line_description: `Beskattningsunderlag import ${rateLabel}`,
    },
    {
      account_number: '4598',
      debit_amount: 0,
      credit_amount: amount,
      line_description: `Motkonto beskattningsunderlag import ${rateLabel}`,
    },
  ]
}

/**
 * Generate input VAT deduction line for domestic purchases
 * Debit 2641 Ingående moms
 */
export function generateInputVatLine(
  totalAmount: number,
  vatRate: number = 0.25
): CreateJournalEntryLineInput | null {
  if (vatRate === 0) return null

  // Extract VAT from total amount (VAT-inclusive)
  const vatAmount = Math.round((totalAmount * vatRate) / (1 + vatRate) * 100) / 100

  return {
    account_number: '2641', // Debiterad ingående moms
    debit_amount: vatAmount,
    credit_amount: 0,
    line_description: `Ingående moms ${vatRate * 100}%`,
  }
}

/**
 * Calculate the net amount (excl VAT) from a total amount
 */
export function extractNetAmount(totalAmount: number, vatRate: number): number {
  if (vatRate === 0) return totalAmount
  return Math.round((totalAmount / (1 + vatRate)) * 100) / 100
}

/**
 * Calculate VAT amount from a total amount (VAT-inclusive)
 */
export function extractVatAmount(totalAmount: number, vatRate: number): number {
  if (vatRate === 0) return 0
  return Math.round((totalAmount - totalAmount / (1 + vatRate)) * 100) / 100
}
