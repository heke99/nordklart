import { describe, it, expect } from 'vitest'
import { resolveSekAmount, buildCurrencyMetadata } from '../currency-utils'

describe('resolveSekAmount', () => {
  it('returns amount as-is for SEK currency', () => {
    expect(resolveSekAmount(1000, null, 'SEK', null)).toBe(1000)
  })

  it('returns amount as-is when currency is null (legacy data)', () => {
    expect(resolveSekAmount(1000, null, null, null)).toBe(1000)
  })

  it('returns amount as-is when currency is undefined', () => {
    expect(resolveSekAmount(1000, null, undefined, null)).toBe(1000)
  })

  it('returns amountSek when populated for foreign currency', () => {
    expect(resolveSekAmount(100, 1150, 'EUR', 11.5)).toBe(1150)
  })

  it('rounds amountSek to 2 decimals', () => {
    expect(resolveSekAmount(100, 1150.456, 'EUR', 11.5)).toBe(1150.46)
  })

  it('computes via exchangeRate when amountSek is null', () => {
    expect(resolveSekAmount(100, null, 'EUR', 11.5)).toBe(1150)
  })

  it('rounds computed amount to 2 decimals', () => {
    // 100.33 * 11.5 = 1153.795 → rounds to 1153.8
    expect(resolveSekAmount(100.33, null, 'EUR', 11.5)).toBe(1153.8)
  })

  it('falls back to original amount when both amountSek and exchangeRate are null', () => {
    expect(resolveSekAmount(100, null, 'EUR', null)).toBe(100)
  })

  it('falls back when exchangeRate is 0', () => {
    expect(resolveSekAmount(100, null, 'EUR', 0)).toBe(100)
  })

  it('handles negative amounts correctly', () => {
    expect(resolveSekAmount(-100, null, 'EUR', 11.5)).toBe(-1150)
  })

  it('prefers amountSek over exchangeRate computation', () => {
    // amountSek = 1200, but exchangeRate would give 1150
    expect(resolveSekAmount(100, 1200, 'EUR', 11.5)).toBe(1200)
  })

  it('handles zero amount', () => {
    expect(resolveSekAmount(0, null, 'EUR', 11.5)).toBe(0)
  })
})

describe('buildCurrencyMetadata', () => {
  it('returns empty object for SEK', () => {
    expect(buildCurrencyMetadata('SEK', 1000, null)).toEqual({})
  })

  it('returns empty object for null currency', () => {
    expect(buildCurrencyMetadata(null, 1000, null)).toEqual({})
  })

  it('returns empty object for undefined currency', () => {
    expect(buildCurrencyMetadata(undefined, 1000, null)).toEqual({})
  })

  it('returns currency metadata for foreign currency', () => {
    expect(buildCurrencyMetadata('EUR', 100, 11.5)).toEqual({
      currency: 'EUR',
      amount_in_currency: 100,
      exchange_rate: 11.5,
    })
  })

  it('omits amount_in_currency when null', () => {
    expect(buildCurrencyMetadata('EUR', null, 11.5)).toEqual({
      currency: 'EUR',
      exchange_rate: 11.5,
    })
  })

  it('omits exchange_rate when null', () => {
    expect(buildCurrencyMetadata('EUR', 100, null)).toEqual({
      currency: 'EUR',
      amount_in_currency: 100,
    })
  })

  it('omits exchange_rate when 0', () => {
    expect(buildCurrencyMetadata('EUR', 100, 0)).toEqual({
      currency: 'EUR',
      amount_in_currency: 100,
    })
  })
})
