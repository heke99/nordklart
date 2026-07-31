import { describe, expect, it } from 'vitest'
import {
  annualReportFileSlug,
  containsForbiddenAnnualReportCharacters,
  formatAnnualReportAmount,
  normalizeAnnualReportText,
} from '../format'

describe('annual report formatting', () => {
  it.each([
    [-0.5, 2, '-0,50'],
    [-1455.5, 0, '-1\u00a0456'],
    [-2154, 0, '-2\u00a0154'],
    [-6299, 0, '-6\u00a0299'],
    [-13595, 0, '-13\u00a0595'],
  ])('renders %s with one canonical ASCII minus', (value, decimals, expected) => {
    expect(formatAnnualReportAmount(value, { decimals })).toBe(expected)
  })

  it('removes hidden controls and normalizes Unicode minus variants', () => {
    const normalized = normalizeAnnualReportText('\u0000−2 154\u001b')
    expect(normalized).toBe('-2 154')
    expect(containsForbiddenAnnualReportCharacters(normalized)).toBe(false)
  })

  it('creates a stable Swedish company filename slug', () => {
    expect(annualReportFileSlug('Gridex EL AB')).toBe('gridex-el-ab')
  })
})
