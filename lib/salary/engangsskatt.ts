/**
 * Engångsskatt — tax on one-time payments (bonuses, retroactive pay, etc.)
 *
 * Per Skatteverket: One-time payments use a percentage-based tax table,
 * not the regular monthly tax table. The rate depends on the employee's
 * estimated annual income level.
 *
 * Skatteverket publishes "Tabell för beräkning av skatteavdrag på
 * engångsbelopp" annually.
 *
 * Simplified 2026 brackets (based on published rates):
 */

export interface EngangsskattResult {
  taxRate: number
  taxAmount: number
  annualIncomeEstimate: number
  steps: { label: string; formula: string; output: number }[]
}

/**
 * 2026 engångsskatt brackets.
 * Rate includes both kommunalskatt and statlig skatt.
 * Based on average kommunalskatt (~32.5%).
 */
const ENGANGSSKATT_BRACKETS_2026: Array<{ fromAnnual: number; toAnnual: number; rate: number }> = [
  { fromAnnual: 0,       toAnnual: 20000,   rate: 0.00 },
  { fromAnnual: 20001,   toAnnual: 50000,   rate: 0.10 },
  { fromAnnual: 50001,   toAnnual: 100000,  rate: 0.20 },
  { fromAnnual: 100001,  toAnnual: 200000,  rate: 0.25 },
  { fromAnnual: 200001,  toAnnual: 350000,  rate: 0.30 },
  { fromAnnual: 350001,  toAnnual: 500000,  rate: 0.32 },
  { fromAnnual: 500001,  toAnnual: 660400,  rate: 0.34 },
  { fromAnnual: 660401,  toAnnual: 950000,  rate: 0.52 }, // State tax kicks in
  { fromAnnual: 950001,  toAnnual: 1500000, rate: 0.55 },
  { fromAnnual: 1500001, toAnnual: Infinity, rate: 0.57 },
]

/**
 * Calculate engångsskatt for a one-time payment.
 *
 * @param oneTimeAmount - The bonus/one-time payment amount
 * @param monthlySalary - Employee's regular monthly salary (for estimating annual income)
 * @param monthsWorkedThisYear - Months already worked (for pro-rata annual estimate)
 */
export function calculateEngangsskatt(
  oneTimeAmount: number,
  monthlySalary: number,
  monthsWorkedThisYear: number = 12
): EngangsskattResult {
  const r = (x: number) => Math.round(x * 100) / 100

  // Estimate annual income = regular salary × 12 + one-time amount
  const annualRegular = monthlySalary * 12
  const annualIncomeEstimate = r(annualRegular + oneTimeAmount)

  // Find the bracket based on total annual income including the one-time payment
  let taxRate = 0.30 // default fallback
  for (const bracket of ENGANGSSKATT_BRACKETS_2026) {
    if (annualIncomeEstimate >= bracket.fromAnnual && annualIncomeEstimate <= bracket.toAnnual) {
      taxRate = bracket.rate
      break
    }
  }

  const taxAmount = r(oneTimeAmount * taxRate)

  return {
    taxRate,
    taxAmount,
    annualIncomeEstimate,
    steps: [
      {
        label: 'Beräknad årsinkomst',
        formula: 'monthly × 12 + engångsbelopp',
        output: annualIncomeEstimate,
      },
      {
        label: `Engångsskatt (${(taxRate * 100).toFixed(0)}%)`,
        formula: `engångsbelopp × ${(taxRate * 100).toFixed(0)}%`,
        output: taxAmount,
      },
    ],
  }
}
