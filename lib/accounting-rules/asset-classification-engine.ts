import type { EntityContext, PurchaseRuleInput, RuleDecision } from './types'

export const LOW_VALUE_INVENTORY_LIMIT_2026_EX_VAT = 29_600
export const SHORT_LIFE_MONTHS = 36

export function classifyAssetCandidate(input: PurchaseRuleInput, context: EntityContext): Pick<RuleDecision, 'decision' | 'reasonCode' | 'explanationSv' | 'reviewSeverity' | 'suggestedAsset'> | null {
  const text = `${input.description} ${input.category ?? ''}`.toLowerCase()
  const amountForThreshold = input.naturalBundleTotalExVat ?? input.amountExVat
  const usefulLife = input.expectedUsefulLifeMonths ?? inferUsefulLifeMonths(text)

  if (input.isPropertyRelated || /fastighet|byggnad|tak|fasad|ventilation|hiss|hyresgäst|markanläggning|renovering|ombyggnad/.test(text)) {
    return {
      decision: 'review_required',
      reasonCode: 'PROPERTY_REQUIRES_SPLIT_OR_REVIEW',
      explanationSv: 'Fastighetsrelaterade inköp måste bedömas som mark, byggnad, markanläggning, reparation, förbättring eller komponentbyte innan bokföring.',
      reviewSeverity: 'blocking',
      suggestedAsset: {
        category: 'building',
        usefulLifeMonths: 600,
        depreciationMethod: 'linear',
        requiresComponentBreakdown: context.accountingFramework === 'k3',
        requiresLandBuildingSplit: true,
      },
    }
  }

  if (input.isVehicle || /bil|fordon|leasingbil|lastbil|transportmedel/.test(text)) {
    return {
      decision: 'review_required',
      reasonCode: 'VEHICLE_REQUIRES_VAT_REVIEW',
      explanationSv: 'Fordon och leasing kan ha begränsad moms- och avdragsrätt. Granska innan automatisk bokföring.',
      reviewSeverity: 'danger',
      suggestedAsset: {
        category: 'vehicle',
        usefulLifeMonths: 60,
        depreciationMethod: 'linear',
      },
    }
  }

  if (amountForThreshold >= LOW_VALUE_INVENTORY_LIMIT_2026_EX_VAT && /dator|laptop|macbook|server|iphone|telefon|kamera|maskin|verktyg|inventarie|utrustning|möbel/.test(text)) {
    return {
      decision: 'asset',
      reasonCode: 'INVENTORY_OVER_LOW_VALUE_LIMIT',
      explanationSv: 'Inköpet verkar vara en inventarie över direktavdragsgränsen och bör normalt läggas upp i anläggningsregistret.',
      reviewSeverity: 'warning',
      suggestedAsset: {
        category: inferAssetCategory(text),
        usefulLifeMonths: usefulLife ?? 60,
        depreciationMethod: 'linear',
      },
    }
  }

  if (usefulLife !== null && usefulLife <= SHORT_LIFE_MONTHS && amountForThreshold >= LOW_VALUE_INVENTORY_LIMIT_2026_EX_VAT) {
    return {
      decision: 'review_required',
      reasonCode: 'SHORT_LIFE_OVER_LIMIT_REQUIRES_CONFIRMATION',
      explanationSv: 'Inköpet är över direktavdragsgränsen men kan vara korttidsinventarie. Bekräfta livslängd innan direktavdrag.',
      reviewSeverity: 'warning',
    }
  }

  if (amountForThreshold < LOW_VALUE_INVENTORY_LIMIT_2026_EX_VAT) {
    return {
      decision: 'expense',
      reasonCode: 'LOW_VALUE_INVENTORY_DIRECT_EXPENSE_2026',
      explanationSv: `Beloppet är under 2026 års gräns för inventarier av mindre värde (${LOW_VALUE_INVENTORY_LIMIT_2026_EX_VAT.toLocaleString('sv-SE')} kr exkl. moms) och föreslås som direktavdrag om inköpet används i verksamheten.`,
      reviewSeverity: input.naturalBundleTotalExVat ? 'warning' : 'info',
    }
  }

  return null
}

function inferAssetCategory(text: string): NonNullable<RuleDecision['suggestedAsset']>['category'] {
  if (/dator|laptop|macbook|server|ipad/.test(text)) return 'computer'
  if (/bil|fordon|lastbil/.test(text)) return 'vehicle'
  if (/maskin|maskiner/.test(text)) return 'machinery'
  if (/fastighet|byggnad/.test(text)) return 'building'
  if (/markanläggning/.test(text)) return 'land_improvement'
  return 'equipment'
}

function inferUsefulLifeMonths(text: string): number | null {
  if (/programvara|software|licens|subscription|abonnemang/.test(text)) return 12
  if (/dator|laptop|macbook|iphone|telefon|ipad/.test(text)) return 36
  if (/möbel|inventarie|utrustning|verktyg/.test(text)) return 60
  if (/maskin|maskiner/.test(text)) return 120
  if (/byggnad|fastighet/.test(text)) return 600
  return null
}
