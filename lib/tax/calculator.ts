import type { EntityType, TaxEstimate } from '@/types'

// Current Swedish tax rates (2026)
const TAX_RATES = {
  egenavgifter: 0.2897, // 28.97% for EF
  bolagsskatt: 0.206, // 20.6% for AB
  arbetsgivaravgifter: 0.3142, // 31.42% employer contributions
  municipalTax: 0.3238, // 32.38% average municipal tax for 2026
  stateTax: 0.20, // 20% state income tax on high incomes
}

// State income tax threshold (brytpunkt) for 2026
const STATE_TAX_THRESHOLD = 643100 // Taxable income above this gets +20% state tax
// Note: The "brytpunkt" is 660,400 kr but that includes grundavdrag

/**
 * Calculate progressive grundavdrag (basic deduction) for 2026
 * Based on Skatteverket's table - varies by income level
 *
 * Income ranges and corresponding grundavdrag:
 * - 0 - 25,100: grundavdrag = income (no tax)
 * - 25,100 - 58,900: 25,100 kr
 * - 58,900 - 161,000: Progressive increase up to 45,600 kr
 * - 161,000 - 184,900: 45,600 kr (maximum)
 * - 184,900 - 466,000: Progressive decrease
 * - 466,000+: 17,400 kr (minimum for high earners)
 */
export function calculateGrundavdrag(taxableIncome: number): number {
  if (taxableIncome <= 0) return 0

  // Very low income - grundavdrag equals income (no tax)
  if (taxableIncome <= 25100) {
    return taxableIncome
  }

  // Low income - minimum grundavdrag
  if (taxableIncome <= 58900) {
    return 25100
  }

  // Rising phase - interpolate between 25,100 and 45,600
  if (taxableIncome <= 161000) {
    const progress = (taxableIncome - 58900) / (161000 - 58900)
    return Math.round(25100 + progress * (45600 - 25100))
  }

  // Maximum grundavdrag zone
  if (taxableIncome <= 184900) {
    return 45600
  }

  // Declining phase - interpolate between 45,600 and 17,400
  if (taxableIncome <= 466000) {
    const progress = (taxableIncome - 184900) / (466000 - 184900)
    return Math.round(45600 - progress * (45600 - 17400))
  }

  // High earners - minimum grundavdrag
  return 17400
}

/**
 * Calculate tax estimates for Enskild Firma
 * @param netIncome - Net income after expenses
 * @param preliminaryTaxPaidYTD - Preliminary tax paid year to date
 * @param _reserved - Reserved for future use (deductions extension)
 * @param momsFromUnpaidInvoices - VAT from unpaid invoices that needs to be paid
 */
export function calculateEFTax(
  netIncome: number,
  preliminaryTaxPaidYTD: number = 0,
  _reserved?: unknown,
  momsFromUnpaidInvoices: number = 0
): TaxEstimate {
  if (netIncome <= 0) {
    return {
      egenavgifter: 0,
      income_tax: 0,
      state_tax: 0,
      moms_to_pay: momsFromUnpaidInvoices,
      total_tax_liability: momsFromUnpaidInvoices,
      preliminary_paid_ytd: preliminaryTaxPaidYTD,
      difference: momsFromUnpaidInvoices - preliminaryTaxPaidYTD,
    }
  }

  // Egenavgifter (self-employment contributions) - 28.97%
  const egenavgifter = netIncome * TAX_RATES.egenavgifter

  // Taxable income (after egenavgifter deduction)
  // 25% of egenavgifter is deductible from taxable income
  const egenavgifterDeduction = egenavgifter * 0.25
  const taxableIncome = netIncome - egenavgifterDeduction

  // Calculate progressive grundavdrag based on income level
  const grundavdrag = calculateGrundavdrag(taxableIncome)
  const incomeAfterGrundavdrag = Math.max(0, taxableIncome - grundavdrag)

  // Municipal income tax (~32.38% average for 2026)
  const municipalTax = incomeAfterGrundavdrag * TAX_RATES.municipalTax

  // State income tax (20% on income above threshold)
  // Only applies to taxable income above 643,100 kr
  const incomeAboveThreshold = Math.max(0, incomeAfterGrundavdrag - STATE_TAX_THRESHOLD)
  const stateTax = incomeAboveThreshold * TAX_RATES.stateTax

  const totalIncomeTax = municipalTax + stateTax
  const totalTax = egenavgifter + totalIncomeTax + momsFromUnpaidInvoices

  return {
    egenavgifter: Math.round(egenavgifter),
    income_tax: Math.round(municipalTax),
    state_tax: Math.round(stateTax),
    moms_to_pay: Math.round(momsFromUnpaidInvoices),
    total_tax_liability: Math.round(totalTax),
    preliminary_paid_ytd: preliminaryTaxPaidYTD,
    difference: Math.round(totalTax - preliminaryTaxPaidYTD),
    grundavdrag: Math.round(grundavdrag),
  }
}

/**
 * Calculate tax estimates for Aktiebolag
 * @param profit - Company profit
 * @param salaryCostsYTD - Salary costs year to date (for reference)
 * @param preliminaryTaxPaidYTD - Preliminary tax paid year to date
 * @param momsFromUnpaidInvoices - VAT from unpaid invoices
 */
export function calculateABTax(
  profit: number,
  salaryCostsYTD: number = 0,
  preliminaryTaxPaidYTD: number = 0,
  momsFromUnpaidInvoices: number = 0
): TaxEstimate {
  // Bolagsskatt on profit
  const bolagsskatt = profit > 0 ? profit * TAX_RATES.bolagsskatt : 0

  // Arbetsgivaravgifter on salaries (already included in salary costs usually)
  // This is just for reference
  const totalTax = bolagsskatt + momsFromUnpaidInvoices

  return {
    bolagsskatt: Math.round(bolagsskatt),
    moms_to_pay: Math.round(momsFromUnpaidInvoices),
    total_tax_liability: Math.round(totalTax),
    preliminary_paid_ytd: preliminaryTaxPaidYTD,
    difference: Math.round(totalTax - preliminaryTaxPaidYTD),
  }
}

/**
 * Calculate available balance (after tax reservations)
 */
export function calculateAvailableBalance(
  currentBalance: number,
  taxEstimate: TaxEstimate
): number {
  const taxReservation = Math.max(0, taxEstimate.total_tax_liability - taxEstimate.preliminary_paid_ytd)
  return Math.max(0, currentBalance - taxReservation)
}

/**
 * Format tax breakdown for display
 */
export function formatTaxBreakdown(
  entityType: EntityType,
  taxEstimate: TaxEstimate
): { label: string; amount: number }[] {
  const items: { label: string; amount: number }[] = []

  if (entityType === 'enskild_firma') {
    if (taxEstimate.egenavgifter) {
      items.push({ label: 'Egenavgifter (28,97%)', amount: taxEstimate.egenavgifter })
    }
    if (taxEstimate.income_tax) {
      items.push({ label: 'Kommunalskatt (~32%)', amount: taxEstimate.income_tax })
    }
    if (taxEstimate.state_tax && taxEstimate.state_tax > 0) {
      items.push({ label: 'Statlig skatt (20%)', amount: taxEstimate.state_tax })
    }
  } else {
    if (taxEstimate.bolagsskatt) {
      items.push({ label: 'Bolagsskatt (20,6%)', amount: taxEstimate.bolagsskatt })
    }
  }

  if (taxEstimate.moms_to_pay > 0) {
    items.push({ label: 'Moms att betala', amount: taxEstimate.moms_to_pay })
  }

  return items
}

/**
 * Calculate balance breakdown for display
 * Shows disponibelt, skatt reservation, and moms reservation separately
 */
export function calculateBalanceBreakdown(
  currentBalance: number,
  taxEstimate: TaxEstimate
): {
  disponibelt: number
  skattReservation: number
  momsReservation: number
  totalLocked: number
} {
  // VAT reservation (separate from income tax)
  const momsReservation = Math.max(0, taxEstimate.moms_to_pay)

  // Income tax/egenavgifter reservation (excluding VAT and what's already paid)
  const incomeTaxLiability = taxEstimate.total_tax_liability - momsReservation
  const skattReservation = Math.max(0, incomeTaxLiability - taxEstimate.preliminary_paid_ytd)

  const totalLocked = skattReservation + momsReservation
  const disponibelt = Math.max(0, currentBalance - totalLocked)

  return {
    disponibelt,
    skattReservation,
    momsReservation,
    totalLocked,
  }
}

/**
 * Calculate available balance (after tax reservations)
 * Enhanced version that returns more details
 */
export function calculateAvailableBalanceDetailed(
  currentBalance: number,
  taxEstimate: TaxEstimate
): {
  availableBalance: number
  breakdown: ReturnType<typeof calculateBalanceBreakdown>
} {
  const breakdown = calculateBalanceBreakdown(currentBalance, taxEstimate)
  return {
    availableBalance: breakdown.disponibelt,
    breakdown,
  }
}
