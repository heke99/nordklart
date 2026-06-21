import type { EntityContext, EntityType, IndustryCode } from './types'

export function normalizeEntityType(value: string | null | undefined): EntityType {
  switch (value) {
    case 'enskild_firma':
    case 'handelsbolag':
    case 'kommanditbolag':
    case 'ekonomisk_forening':
    case 'aktiebolag':
      return value
    default:
      return 'aktiebolag'
  }
}

export function normalizeIndustryCode(value: string | null | undefined): IndustryCode {
  switch (value) {
    case 'consulting':
    case 'construction':
    case 'real_estate':
    case 'restaurant':
    case 'transport':
    case 'retail':
    case 'ecommerce':
    case 'healthcare':
    case 'service':
      return value
    default:
      return 'general'
  }
}

export function createDefaultEntityContext(partial: Partial<EntityContext> = {}): EntityContext {
  return {
    entityType: partial.entityType ?? 'aktiebolag',
    industryCode: partial.industryCode ?? 'general',
    accountingFramework: partial.accountingFramework ?? 'k2',
    isVatRegistered: partial.isVatRegistered ?? true,
    fiscalYearStart: partial.fiscalYearStart ?? `${new Date().getFullYear()}-01-01`,
    fiscalYearEnd: partial.fiscalYearEnd ?? `${new Date().getFullYear()}-12-31`,
  }
}
