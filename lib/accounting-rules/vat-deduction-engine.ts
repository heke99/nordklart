import type { EntityContext, PurchaseRuleInput, VatTreatment } from './types'

export interface VatDecision {
  vatTreatment: VatTreatment
  deductiblePercentage: number
  warnings: string[]
}

export function decideVatTreatment(input: PurchaseRuleInput, context: EntityContext): VatDecision {
  const warnings: string[] = []

  if (!context.isVatRegistered) {
    return {
      vatTreatment: 'unknown',
      deductiblePercentage: 0,
      warnings: ['Företaget verkar inte vara momsregistrerat. Ingående moms ska normalt inte lyftas.'],
    }
  }

  if (input.isFinancialOrInsurance) {
    return { vatTreatment: 'exempt', deductiblePercentage: 0, warnings: [] }
  }

  if (input.isEuOrImport) {
    warnings.push('EU/import kräver särskild momshantering och ska granskas innan bokföring.')
    return { vatTreatment: 'unknown', deductiblePercentage: 0, warnings }
  }

  const rate = input.vatRate ?? inferVatRate(input)
  if (rate === 25) return { vatTreatment: 'standard_25', deductiblePercentage: 100, warnings }
  if (rate === 12) return { vatTreatment: 'reduced_12', deductiblePercentage: 100, warnings }
  if (rate === 6) return { vatTreatment: 'reduced_6', deductiblePercentage: 100, warnings }
  if (rate === 0) {
    warnings.push('Momssats 0 % behöver kontrolleras mot fakturan/kvittot så att inköpet inte bokförs med fel moms.')
    return { vatTreatment: 'zero', deductiblePercentage: 0, warnings }
  }

  warnings.push('Momssats kunde inte avgöras säkert. Användaren/byrån behöver kontrollera underlaget.')
  return { vatTreatment: 'unknown', deductiblePercentage: 0, warnings }
}

function inferVatRate(input: PurchaseRuleInput): number | null {
  if (typeof input.vatAmount === 'number' && input.amountExVat > 0) {
    const rate = Math.round((input.vatAmount / input.amountExVat) * 100)
    if ([0, 6, 12, 25].includes(rate)) return rate
  }
  return null
}
