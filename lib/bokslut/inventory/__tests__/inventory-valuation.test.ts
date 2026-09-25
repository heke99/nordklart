import { describe, expect, it } from 'vitest'
import { InventoryValuationError, planInventoryAdjustment, valueInventory } from '../inventory-valuation'

describe('valueInventory (IL 17 kap. 3–4 §§)', () => {
  it('uses the lower of cost and net realisable value', () => {
    expect(valueInventory({ account: '1460', cost: 100_000, netRealizableValue: 90_000, method: 'lowest_value' }).value).toBe(90_000)
    expect(valueInventory({ account: '1460', cost: 100_000, method: 'lowest_value' }).value).toBe(100_000)
  })

  it('allows 97 % of cost under the alternative rule', () => {
    const v = valueInventory({ account: '1460', cost: 100_000, method: 'alternative_97' })
    expect(v.value).toBe(97_000)
    expect(v.taxFloor).toBe(97_000)
    expect(v.changeAccount).toBe('4960')
  })

  it('rejects non-inventory accounts', () => {
    expect(() => valueInventory({ account: '1930', cost: 1, method: 'lowest_value' })).toThrow(InventoryValuationError)
  })
})

describe('planInventoryAdjustment', () => {
  it('books an increase Dr 1460 / Cr 4960', () => {
    const lines = planInventoryAdjustment(valueInventory({ account: '1460', cost: 120_000, method: 'lowest_value' }), 100_000)
    expect(lines).toMatchObject([
      { account_number: '1460', debit_amount: 20_000, credit_amount: 0 },
      { account_number: '4960', debit_amount: 0, credit_amount: 20_000 },
    ])
  })

  it('books a decrease Dr 4950 / Cr 1450', () => {
    const lines = planInventoryAdjustment(valueInventory({ account: '1450', cost: 30_000, method: 'lowest_value' }), 50_000)
    expect(lines).toMatchObject([
      { account_number: '4950', debit_amount: 20_000 },
      { account_number: '1450', credit_amount: 20_000 },
    ])
  })

  it('is empty when the booked balance already matches', () => {
    expect(planInventoryAdjustment(valueInventory({ account: '1460', cost: 50_000, method: 'lowest_value' }), 50_000)).toEqual([])
  })
})
