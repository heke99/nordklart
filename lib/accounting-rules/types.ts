export type EntityType =
  | 'aktiebolag'
  | 'enskild_firma'
  | 'handelsbolag'
  | 'kommanditbolag'
  | 'ekonomisk_forening'

export type IndustryCode =
  | 'general'
  | 'consulting'
  | 'construction'
  | 'real_estate'
  | 'restaurant'
  | 'transport'
  | 'retail'
  | 'ecommerce'
  | 'healthcare'
  | 'service'

export type AccountingDecision = 'expense' | 'asset' | 'private' | 'mixed' | 'review_required'

export type ReviewSeverity = 'none' | 'info' | 'warning' | 'danger' | 'blocking'

export type VatTreatment =
  | 'standard_25'
  | 'reduced_12'
  | 'reduced_6'
  | 'zero'
  | 'exempt'
  | 'reverse_charge'
  | 'eu_goods'
  | 'eu_services'
  | 'import'
  | 'unknown'

export interface EntityContext {
  entityType: EntityType
  industryCode: IndustryCode
  accountingFramework: 'k2' | 'k3'
  isVatRegistered: boolean
  fiscalYearStart: string
  fiscalYearEnd: string
}

export interface PurchaseRuleInput {
  description: string
  amountExVat: number
  vatAmount?: number | null
  vatRate?: number | null
  supplierName?: string | null
  category?: string | null
  purchaseDate?: string | null
  expectedUsefulLifeMonths?: number | null
  businessUsePercent?: number | null
  privateUsePercent?: number | null
  naturalBundleTotalExVat?: number | null
  isCompanyPurchase?: boolean | null
  isRepresentation?: boolean | null
  isVehicle?: boolean | null
  isPropertyRelated?: boolean | null
  isFinancialOrInsurance?: boolean | null
  isEuOrImport?: boolean | null
}

export interface RequiredEvidence {
  code: string
  labelSv: string
}

export interface RuleDecision {
  decision: AccountingDecision
  accountNumber: string | null
  vatTreatment: VatTreatment
  deductiblePercentage: number
  privatePercentage: number
  reasonCode: string
  explanationSv: string
  requiredEvidence: RequiredEvidence[]
  reviewSeverity: ReviewSeverity
  warnings: string[]
  suggestedAsset?: {
    category: 'immaterial' | 'building' | 'land_improvement' | 'machinery' | 'equipment' | 'vehicle' | 'computer' | 'other_tangible'
    usefulLifeMonths: number
    depreciationMethod: 'linear' | 'declining_balance_30' | 'declining_balance_20' | 'restvardesavskrivning_25'
    requiresComponentBreakdown?: boolean
    requiresLandBuildingSplit?: boolean
  }
}

export interface DeductibilityRule {
  ruleCode: string
  appliesToEntityType?: EntityType | 'all'
  industryCode?: IndustryCode | 'all'
  category: string
  maxAmountExVat?: number
  vatDeductible: boolean | 'partial' | 'unknown'
  incomeTaxDeductible: boolean | 'partial' | 'unknown'
  requiresPurpose?: boolean
  requiresParticipants?: boolean
  requiresPrivateUseSplit?: boolean
  defaultAccount: string
  nonDeductibleAccount?: string
  reviewSeverity: ReviewSeverity
}
