import { roundOre } from '@/lib/money'
import { calculateAvgifterRate, type SalaryCalculationInput } from './calculation-engine'
import type { PayrollConfig } from './payroll-config'

/**
 * Impact of the 2026-09-25 avgift age-tier corrections on salary already
 * calculated: the reduced avgift from 66 (not 67) at the start of 2025, and
 * "vid årets ingång" counted by birth year (Skatteverket) instead of exact
 * date. Recomputes the avgift category of a stored salary_run_employees row
 * with today's rules and reports the difference. Read-only — used by
 * scripts/reports/avgift-age-tier-impact.ts as the basis for AGI corrections.
 */

export interface StoredAvgiftRow {
  paymentDate: string
  encryptedPersonnummer: string
  vaxaStodEligible: boolean
  vaxaStodStart: string | null
  vaxaStodEnd: string | null
  storedCategory: string | null
  storedRate: number
  storedAmount: number
  basis: number
  hasOverride: boolean
}

export interface AvgiftTierImpact {
  storedCategory: string | null
  correctCategory: string
  storedRate: number
  correctRate: number
  storedAmount: number
  correctAmount: number
  /** correctAmount − storedAmount: positive means too little was reported and paid. */
  difference: number
}

/** Avgift for a basis in a category, with the youth / växa-stöd salary caps. */
export function avgiftAmount(category: string, rate: number, basis: number, config: PayrollConfig): number {
  if (basis <= 0) return 0
  const cap =
    category === 'youth' ? config.avgifterYouthSalaryCap
    : category === 'vaxa_stod' ? config.avgifterVaxaStodCap
    : null
  if (cap && basis > cap) {
    return roundOre(roundOre(cap * rate) + roundOre((basis - cap) * config.avgifterTotal))
  }
  return roundOre(basis * rate)
}

/**
 * Returns the impact when the row's category or amount differs under today's
 * rules; null when it is unchanged, has a manual override, or has no basis
 * (F-skatt).
 */
export function assessAvgiftTierImpact(row: StoredAvgiftRow, config: PayrollConfig): AvgiftTierImpact | null {
  if (row.hasOverride || row.basis <= 0) return null
  const input = {
    personnummer: row.encryptedPersonnummer,
    paymentDate: row.paymentDate,
    vaxaStodEligible: row.vaxaStodEligible,
    vaxaStodStart: row.vaxaStodStart,
    vaxaStodEnd: row.vaxaStodEnd,
  } as SalaryCalculationInput
  const year = Number(row.paymentDate.slice(0, 4))
  const correct = calculateAvgifterRate(input, config, year)
  const correctAmount = avgiftAmount(correct.category, correct.rate, row.basis, config)
  const difference = roundOre(correctAmount - row.storedAmount)
  if (correct.category === row.storedCategory && Math.abs(difference) < 0.01) return null
  if (row.storedCategory === null && correct.rate === row.storedRate && Math.abs(difference) < 0.01) return null
  return {
    storedCategory: row.storedCategory,
    correctCategory: correct.category,
    storedRate: row.storedRate,
    correctRate: correct.rate,
    storedAmount: row.storedAmount,
    correctAmount,
    difference,
  }
}
