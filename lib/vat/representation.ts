/**
 * Representation — moms-avdragsbegränsning (ML 2023:200 13 kap 27 §).
 *
 * Input VAT on meals/refreshments at representation (extern & intern) is
 * deductible only on a base of at most 300 SEK per person excl. VAT.
 * The income-tax deduction for representation meals was abolished 2017
 * (IL 16 kap 2 §) — the amount above the deductible VAT is a cost.
 *
 *   max deductible VAT = participants × 300 × vatRate
 *
 * For mixed-rate meals (mat 12% + alkohol 25%) Skatteverket allows a
 * schablon of 46 kr/person instead of an exact proportion; we apply the
 * exact per-rate cap, which is never more generous than the schablon for
 * single-rate lines and is auditable line by line.
 */

import { roundOre } from '@/lib/money'

/** Max deduction base per person, SEK excl VAT (ML 13 kap 27 §). */
export const REPRESENTATION_VAT_BASE_CAP_SEK = 300

/** BAS accounts that carry representation costs. */
export const REPRESENTATION_ACCOUNT_PATTERN = /^607\d$/

export function isRepresentationAccount(accountNumber: string): boolean {
  return REPRESENTATION_ACCOUNT_PATTERN.test(accountNumber)
}

/**
 * Maximum deductible input VAT for a representation meal.
 * `vatRate` is a fraction (0.12, 0.25).
 */
export function maxDeductibleRepresentationVat(
  participantCount: number,
  vatRate: number,
): number {
  if (!Number.isFinite(participantCount) || participantCount <= 0) return 0
  if (!Number.isFinite(vatRate) || vatRate <= 0) return 0
  return roundOre(participantCount * REPRESENTATION_VAT_BASE_CAP_SEK * vatRate)
}

/**
 * Cap a representation line's input VAT at the statutory maximum.
 * Returns the deductible VAT and the excess (which is a cost, not
 * deductible input VAT).
 */
export function capRepresentationVat(args: {
  vatAmount: number
  participantCount: number
  vatRate: number
}): { deductible: number; excess: number } {
  const total = roundOre(args.vatAmount)
  const max = maxDeductibleRepresentationVat(args.participantCount, args.vatRate)
  if (total <= max) return { deductible: total, excess: 0 }
  return {
    deductible: max,
    excess: roundOre(total - max),
  }
}
