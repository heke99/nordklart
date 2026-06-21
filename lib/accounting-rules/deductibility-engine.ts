import type { DeductibilityRule, EntityContext, PurchaseRuleInput, RequiredEvidence, ReviewSeverity } from './types'

export interface DeductibilityDecision {
  accountNumber: string
  deductiblePercentage: number
  privatePercentage: number
  reviewSeverity: ReviewSeverity
  reasonCode: string
  explanationSv: string
  requiredEvidence: RequiredEvidence[]
  warnings: string[]
}

export const CORE_DEDUCTIBILITY_RULES: DeductibilityRule[] = [
  {
    ruleCode: 'REPRESENTATION_REQUIRES_PURPOSE_PARTICIPANTS',
    category: 'representation',
    vatDeductible: 'partial',
    incomeTaxDeductible: 'partial',
    requiresPurpose: true,
    requiresParticipants: true,
    defaultAccount: '6071',
    nonDeductibleAccount: '6072',
    reviewSeverity: 'danger',
  },
  {
    ruleCode: 'CLOTHING_PRIVATE_BY_DEFAULT',
    category: 'clothing',
    vatDeductible: false,
    incomeTaxDeductible: false,
    requiresPurpose: true,
    defaultAccount: '6992',
    nonDeductibleAccount: '6992',
    reviewSeverity: 'danger',
  },
  {
    ruleCode: 'GYM_OWNER_PRIVATE_RISK',
    category: 'wellness',
    vatDeductible: 'unknown',
    incomeTaxDeductible: 'unknown',
    requiresPurpose: true,
    defaultAccount: '7699',
    nonDeductibleAccount: '6992',
    reviewSeverity: 'warning',
  },
]

export function evaluateDeductibility(input: PurchaseRuleInput, context: EntityContext): DeductibilityDecision {
  const text = `${input.description} ${input.category ?? ''}`.toLowerCase()
  const requiredEvidence: RequiredEvidence[] = []
  const warnings: string[] = []
  const businessUse = clampPercent(input.businessUsePercent ?? (input.privateUsePercent != null ? 100 - input.privateUsePercent : 100))
  const privateUse = clampPercent(input.privateUsePercent ?? (100 - businessUse))

  if (input.isCompanyPurchase === false || businessUse <= 0) {
    return {
      accountNumber: '6992',
      deductiblePercentage: 0,
      privatePercentage: 100,
      reviewSeverity: 'blocking',
      reasonCode: 'PRIVATE_OR_NOT_COMPANY_PURCHASE',
      explanationSv: 'Inköpet verkar inte tillhöra verksamheten och ska inte bokföras som avdragsgill kostnad.',
      requiredEvidence: [],
      warnings: ['Privata kostnader får inte bokföras som avdragsgilla företagskostnader.'],
    }
  }

  if (input.isRepresentation || /representation|lunch|middag|restaurang|café|fika|kundmöte/.test(text)) {
    requiredEvidence.push({ code: 'purpose', labelSv: 'syfte med representationen' })
    requiredEvidence.push({ code: 'participants', labelSv: 'deltagare/personantal' })
    return {
      accountNumber: '6071',
      deductiblePercentage: businessUse,
      privatePercentage: privateUse,
      reviewSeverity: 'danger',
      reasonCode: 'REPRESENTATION_REQUIRES_REVIEW',
      explanationSv: 'Representation kräver syfte, deltagare och kontroll av begränsad avdrags- och momslogik innan bokföring.',
      requiredEvidence,
      warnings,
    }
  }

  if (/kläder|mode|kostym|skor|frisör|smink|kosmetika/.test(text)) {
    requiredEvidence.push({ code: 'business_necessity', labelSv: 'varför kostnaden är nödvändig i verksamheten' })
    return {
      accountNumber: '6992',
      deductiblePercentage: 0,
      privatePercentage: 100,
      reviewSeverity: 'danger',
      reasonCode: 'PRIVATE_COST_RISK',
      explanationSv: 'Kläder, skönhet och liknande personliga kostnader är normalt privata om de inte uppfyller särskilda krav.',
      requiredEvidence,
      warnings,
    }
  }

  if (privateUse > 0) {
    requiredEvidence.push({ code: 'private_use_split', labelSv: 'fördelning mellan privat och företagsmässig användning' })
    warnings.push('Blandad användning kräver att bara företagets andel bokförs som avdragsgill.')
    return {
      accountNumber: defaultExpenseAccount(text),
      deductiblePercentage: businessUse,
      privatePercentage: privateUse,
      reviewSeverity: 'warning',
      reasonCode: 'MIXED_USE_SPLIT_REQUIRED',
      explanationSv: 'Inköpet verkar ha både privat och företagsmässig användning. Systemet föreslår delning enligt angiven andel.',
      requiredEvidence,
      warnings,
    }
  }

  return {
    accountNumber: defaultExpenseAccount(text),
    deductiblePercentage: 100,
    privatePercentage: 0,
    reviewSeverity: 'none',
    reasonCode: 'BUSINESS_EXPENSE_DEFAULT',
    explanationSv: 'Inköpet verkar vara en företagskostnad utan särskild riskmarkering.',
    requiredEvidence,
    warnings,
  }
}

function defaultExpenseAccount(text: string): string {
  if (/programvara|software|licens|saas|abonnemang/.test(text)) return '5420'
  if (
  /dator|laptop|telefon|iphone|ipad|utrustning|inventarie|verktyg|möbel|möbler|stol|bord|skärm|monitor|tangentbord|mus|kontorsutrustning|kontorsinventarie/.test(text)
) return '5410'
  if (/lokalhyra|kontorshyra|hyra lokal|hyra för lokal|office rent|rent premises/.test(text)) return '5010'
  if (/marknadsföring|annons|ads|google|meta|facebook/.test(text)) return '5910'
  if (/resa|hotell|taxi|uber|tåg|flyg/.test(text)) return '5800'
  return '6991'
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 100
  return Math.max(0, Math.min(100, Math.round(value)))
}
