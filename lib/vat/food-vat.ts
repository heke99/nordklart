/**
 * Temporarily reduced VAT on livsmedel (Prop. 2025/26:55): 6 % instead of
 * 12 % for supplies from 2026-04-01 through 2027-12-31 (Skatteverket,
 * "Livsmedelsmomsen sänks till 6 procent"). The decisive date is when the
 * tax liability arises — for goods, the supply (delivery) date — not the
 * invoice date.
 *
 * Restaurant and catering services stay at 12 %; spirits, wine and strong
 * beer stay at 25 %. Takeaway without service is livsmedel.
 */
export const FOOD_VAT_REDUCTION = { from: '2026-04-01', to: '2027-12-31' } as const

export function isFoodVatReductionActive(supplyDate: string): boolean {
  const date = supplyDate.slice(0, 10)
  return date >= FOOD_VAT_REDUCTION.from && date <= FOOD_VAT_REDUCTION.to
}

/** VAT rate (decimal) for livsmedel supplied on the given date. */
export function getFoodVatRate(supplyDate: string): 0.06 | 0.12 {
  return isFoodVatReductionActive(supplyDate) ? 0.06 : 0.12
}
