import type { Asset, K3Component } from '@/types'

export type PropertyKind = 'hyreshus' | 'industribyggnad' | 'ekonomibyggnad' | 'ovrig' | 'mixed'
export type AccountingDepreciationModel = 'k2_single_unit' | 'k3_components' | 'tax_plan'

export interface AssetPropertyInput {
  category: Asset['category']
  acquisition_cost: number
  useful_life_months?: number | null
  asset_subtype?: string | null
  property_kind?: PropertyKind | null
  land_value?: number | null
  building_value?: number | null
  tax_depreciation_rate?: number | null
  accounting_depreciation_rate?: number | null
  accounting_depreciation_model?: AccountingDepreciationModel | null
  private_use_percentage?: number | null
  business_use_percentage?: number | null
  k3_components?: K3Component[] | null
}

export interface AssetPropertyValidationResult {
  errors: string[]
  warnings: string[]
}

export function depreciableBaseForAsset(asset: Pick<Asset, 'category' | 'acquisition_cost'> & Partial<Pick<Asset, 'land_value' | 'building_value'>>): number {
  const acquisition = Number(asset.acquisition_cost) || 0
  if (asset.category !== 'building') return acquisition
  const buildingValue = Number(asset.building_value ?? 0)
  if (buildingValue > 0) return buildingValue
  const landValue = Number(asset.land_value ?? 0)
  if (landValue > 0) return Math.max(0, acquisition - landValue)
  return acquisition
}

export function componentValidationBase(input: AssetPropertyInput): number {
  if (input.category === 'building') {
    const buildingValue = Number(input.building_value ?? 0)
    if (buildingValue > 0) return buildingValue
  }
  return Number(input.acquisition_cost)
}

export function validateAssetPropertyRules(input: AssetPropertyInput, accountingFramework: 'k2' | 'k3' = 'k2'): AssetPropertyValidationResult {
  const errors: string[] = []
  const warnings: string[] = []
  const acquisition = Number(input.acquisition_cost)
  const land = Number(input.land_value ?? 0)
  const building = Number(input.building_value ?? 0)
  const business = input.business_use_percentage ?? 100
  const privateUse = input.private_use_percentage ?? 0

  if (business < 0 || business > 100 || privateUse < 0 || privateUse > 100) {
    errors.push('business_use_percentage och private_use_percentage måste ligga mellan 0 och 100.')
  } else if (Math.round((business + privateUse) * 100) / 100 !== 100) {
    errors.push('business_use_percentage och private_use_percentage måste summera till 100 %.')
  }

  if (input.category === 'building') {
    if (land <= 0 && building <= 0) {
      errors.push('Fastighet/byggnad kräver fördelning mellan markvärde och byggnadsvärde innan avskrivning kan göras.')
    }
    if (land < 0 || building < 0) {
      errors.push('Markvärde och byggnadsvärde får inte vara negativa.')
    }
    if (land + building > acquisition + 1) {
      errors.push('Markvärde + byggnadsvärde får inte överstiga anskaffningsvärdet.')
    }
    if (land > 0) {
      warnings.push('Markvärde är inte avskrivningsbart. Avskrivningsmotorn använder bara byggnadsvärdet som avskrivningsbas.')
    }
    if (building > 0 && input.useful_life_months != null && input.useful_life_months < 240) {
      errors.push('Byggnad får inte läggas upp med kort avskrivningstid som vanlig inventarie. Ange korrekt plan/komponenter.')
    }
    if (accountingFramework === 'k3' && (!input.k3_components || input.k3_components.length === 0)) {
      errors.push('K3-byggnad kräver komponentanalys innan tillgången kan sparas.')
    }
  }

  if (input.category === 'land_improvement' && input.useful_life_months != null && input.useful_life_months < 120) {
    warnings.push('Markanläggning bör normalt hanteras med särskild avskrivningsplan. Kontrollera om 5 % eller annan regel gäller.')
  }

  return { errors, warnings }
}
