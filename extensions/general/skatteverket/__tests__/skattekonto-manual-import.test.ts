import { describe, it, expect } from 'vitest'
import { parseSkattekontoStatement, parseSwedishAmount } from '../lib/skattekonto-manual-import'

describe('parseSwedishAmount', () => {
  it('parses Swedish thousands + comma decimals', () => {
    expect(parseSwedishAmount('1 234,56')).toBe(1234.56)
    expect(parseSwedishAmount('-14 380')).toBe(-14380)
    expect(parseSwedishAmount('14380')).toBe(14380)
    expect(parseSwedishAmount('8 500,00')).toBe(8500)
  })

  it('handles non-breaking spaces (as copied from SKV web tables)', () => {
    expect(parseSwedishAmount('1\u00a0234,56')).toBe(1234.56)
  })

  it('rejects non-numeric input', () => {
    expect(parseSwedishAmount('abc')).toBeNull()
    expect(parseSwedishAmount('')).toBeNull()
    expect(parseSwedishAmount('12,34,56')).toBeNull()
  })
})

describe('parseSkattekontoStatement', () => {
  it('parses tab-separated kontoutdrag rows', () => {
    const text = [
      'Datum\tSpecifikation\tBelopp',
      '2026-06-12\tInbetalning bokförd 260612\t14 380',
      '2026-06-14\tMoms feb-mars 2026\t-14 380',
    ].join('\n')

    const result = parseSkattekontoStatement(text)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toEqual({
      transaktionsdatum: '2026-06-12',
      transaktionstext: 'Inbetalning bokförd 260612',
      belopp: 14380,
    })
    expect(result.rows[1].belopp).toBe(-14380)
    expect(result.issues).toHaveLength(0)
  })

  it('parses semicolon-separated rows', () => {
    const result = parseSkattekontoStatement('2026-06-01;Debiterad preliminärskatt;-8 500,00')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].transaktionstext).toBe('Debiterad preliminärskatt')
    expect(result.rows[0].belopp).toBe(-8500)
  })

  it('parses multi-space separated rows', () => {
    const result = parseSkattekontoStatement('2026-06-03  Intäktsränta   12,50')
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].belopp).toBe(12.5)
  })

  it('skips header rows silently but flags broken data rows', () => {
    const text = [
      'Skattekonto kontoutdrag',
      '2026-06-12\tInbetalning\t100',
      '2026-13-99 this is broken',
    ].join('\n')
    const result = parseSkattekontoStatement(text)
    expect(result.rows).toHaveLength(1)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].line).toBe(3)
  })

  it('returns empty for empty input', () => {
    const result = parseSkattekontoStatement('')
    expect(result.rows).toHaveLength(0)
  })
})
