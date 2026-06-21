import { describe, expect, it } from 'vitest'
import { depreciableBaseForAsset, validateAssetPropertyRules } from '../property-rules'

describe('asset property rules', () => {
  it('excludes land value from depreciable base', () => {
    expect(
      depreciableBaseForAsset({
        category: 'building',
        acquisition_cost: 10_000_000,
        land_value: 3_000_000,
        building_value: 7_000_000,
      }),
    ).toBe(7_000_000)
  })

  it('rejects building without land/building split', () => {
    const result = validateAssetPropertyRules({
      category: 'building',
      acquisition_cost: 10_000_000,
      useful_life_months: 600,
    })

    expect(result.errors.join(' ')).toContain('fördelning mellan markvärde och byggnadsvärde')
  })

  it('requires K3 components for K3 building', () => {
    const result = validateAssetPropertyRules(
      {
        category: 'building',
        acquisition_cost: 10_000_000,
        land_value: 2_000_000,
        building_value: 8_000_000,
        useful_life_months: 600,
      },
      'k3',
    )

    expect(result.errors.join(' ')).toContain('K3-byggnad kräver komponentanalys')
  })
})
