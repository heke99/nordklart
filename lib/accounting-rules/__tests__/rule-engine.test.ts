import { describe, expect, it } from 'vitest'
import { createDefaultEntityContext, evaluatePurchaseForAccounting } from '@/lib/accounting-rules'

const context = createDefaultEntityContext({ fiscalYearStart: '2026-01-01', fiscalYearEnd: '2026-12-31' })

describe('accounting rule engine', () => {
  it('suggests direct expense for low-value inventory below the 2026 threshold', () => {
    const decision = evaluatePurchaseForAccounting(
      {
        description: 'Skärm till kontoret',
        amountExVat: 4_000,
        vatRate: 25,
        expectedUsefulLifeMonths: 60,
      },
      context,
    )

    expect(decision.decision).toBe('expense')
    expect(decision.reasonCode).toBe('LOW_VALUE_INVENTORY_DIRECT_EXPENSE_2026')
    expect(decision.accountNumber).toBe('5410')
    expect(decision.vatTreatment).toBe('standard_25')
  })

  it('suggests asset register for inventory over the direct deduction threshold', () => {
    const decision = evaluatePurchaseForAccounting(
      {
        description: 'MacBook Pro dator',
        amountExVat: 34_000,
        vatRate: 25,
        expectedUsefulLifeMonths: 36,
      },
      context,
    )

    expect(decision.decision).toBe('asset')
    expect(decision.reasonCode).toBe('INVENTORY_OVER_LOW_VALUE_LIMIT')
  })

  it('uses bundle amount when multiple related items are bought together', () => {
    const decision = evaluatePurchaseForAccounting(
      {
        description: 'Datorpaket med skärm, docka och tangentbord',
        amountExVat: 12_000,
        naturalBundleTotalExVat: 42_000,
        vatRate: 25,
        expectedUsefulLifeMonths: 60,
      },
      context,
    )

    expect(decision.decision).toBe('asset')
    expect(decision.reasonCode).toBe('INVENTORY_OVER_LOW_VALUE_LIMIT')
    expect(decision.suggestedAsset?.category).toBe('computer')
  })

  it('blocks property related purchase for review and land/building split', () => {
    const decision = evaluatePurchaseForAccounting(
      {
        description: 'Fastighet med mark och byggnad',
        amountExVat: 10_000_000,
        isPropertyRelated: true,
        vatRate: 0,
      },
      context,
    )

    expect(decision.decision).toBe('review_required')
    expect(decision.reviewSeverity).toBe('blocking')
    expect(decision.requiredEvidence.some((item) => item.code === 'land_building_split')).toBe(true)
  })

  it('requires representation evidence', () => {
    const decision = evaluatePurchaseForAccounting(
      {
        description: 'Lunch med kund',
        amountExVat: 900,
        isRepresentation: true,
        vatRate: 12,
      },
      context,
    )

    expect(decision.decision).toBe('expense')
    expect(decision.reviewSeverity).toBe('danger')
    expect(decision.requiredEvidence.map((item) => item.code)).toContain('participants')
  })
})
