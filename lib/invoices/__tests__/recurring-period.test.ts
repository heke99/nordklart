import { describe, it, expect } from 'vitest'
import {
  applyPeriodPlaceholders,
  billingPeriod,
  formatPeriodSv,
  lineAppliesToPeriod,
  nextRunDate,
  scheduleEndsAfterRun,
} from '@/lib/invoices/recurring-period'

describe('nextRunDate', () => {
  it('advances one month and keeps the day', () => {
    expect(nextRunDate('2026-10-25', 25)).toBe('2026-11-25')
  })

  it('advances by the interval: quarterly and yearly', () => {
    expect(nextRunDate('2026-10-01', 1, 3)).toBe('2027-01-01')
    expect(nextRunDate('2026-10-01', 1, 12)).toBe('2027-10-01')
  })

  it('clamps the 31st in short months and returns to it later', () => {
    expect(nextRunDate('2027-01-31', 31)).toBe('2027-02-28')
    expect(nextRunDate('2027-02-28', 31)).toBe('2027-03-31')
  })

  it('advances from the scheduled date, so a missed run is not skipped', () => {
    // Scheduled 2026-08-15 but processed in October: the next run is September.
    expect(nextRunDate('2026-08-15', 15)).toBe('2026-09-15')
  })

  it('rejects unsupported intervals and days', () => {
    expect(() => nextRunDate('2026-10-01', 1, 5)).toThrow()
    expect(() => nextRunDate('2026-10-01', 32)).toThrow()
  })
})

describe('billingPeriod', () => {
  it('covers the run month for current_period', () => {
    expect(billingPeriod('2026-10-15', 1, 'current_period')).toEqual({ start: '2026-10-01', end: '2026-10-31' })
  })

  it('covers the next month for rent paid in advance', () => {
    expect(billingPeriod('2026-10-25', 1, 'next_period')).toEqual({ start: '2026-11-01', end: '2026-11-30' })
  })

  it('covers the previous quarter in arrears across a year boundary', () => {
    expect(billingPeriod('2027-01-05', 3, 'previous_period')).toEqual({ start: '2026-10-01', end: '2026-12-31' })
  })

  it('covers twelve months for a yearly subscription', () => {
    expect(billingPeriod('2026-03-01', 12, 'current_period')).toEqual({ start: '2026-03-01', end: '2027-02-28' })
  })
})

describe('period text', () => {
  it('formats one month, a range in one year and a range across years', () => {
    expect(formatPeriodSv({ start: '2026-10-01', end: '2026-10-31' })).toBe('oktober 2026')
    expect(formatPeriodSv({ start: '2026-10-01', end: '2026-12-31' })).toBe('oktober–december 2026')
    expect(formatPeriodSv({ start: '2026-12-01', end: '2027-02-28' })).toBe('december 2026–februari 2027')
  })

  it('fills the placeholders in a line description', () => {
    const period = { start: '2026-11-01', end: '2026-11-30' }
    expect(applyPeriodPlaceholders('Hyra {period}', period)).toBe('Hyra november 2026')
    expect(applyPeriodPlaceholders('Abonnemang {månad} {år}', period)).toBe('Abonnemang november 2026')
    expect(applyPeriodPlaceholders('Fast pris', period)).toBe('Fast pris')
  })
})

describe('lineAppliesToPeriod', () => {
  const november = { start: '2026-11-01', end: '2026-11-30' }

  it('includes unlimited lines and lines whose range overlaps the period', () => {
    expect(lineAppliesToPeriod({}, november)).toBe(true)
    expect(lineAppliesToPeriod({ valid_from: '2026-11-01', valid_until: '2026-11-30' }, november)).toBe(true)
    expect(lineAppliesToPeriod({ valid_from: '2026-10-15', valid_until: '2026-11-05' }, november)).toBe(true)
  })

  it('excludes lines for other months', () => {
    expect(lineAppliesToPeriod({ valid_from: '2026-12-01', valid_until: '2026-12-31' }, november)).toBe(false)
    expect(lineAppliesToPeriod({ valid_until: '2026-10-31' }, november)).toBe(false)
  })
})

describe('scheduleEndsAfterRun', () => {
  it('ends after the last allowed invoice', () => {
    expect(scheduleEndsAfterRun({ generatedAfterRun: 12, maxOccurrences: 12, endDate: null, nextRunDate: '2027-01-01' })).toBe(true)
    expect(scheduleEndsAfterRun({ generatedAfterRun: 11, maxOccurrences: 12, endDate: null, nextRunDate: '2027-01-01' })).toBe(false)
  })

  it('ends when the next run would fall after the end date', () => {
    expect(scheduleEndsAfterRun({ generatedAfterRun: 3, maxOccurrences: null, endDate: '2026-12-31', nextRunDate: '2027-01-25' })).toBe(true)
    expect(scheduleEndsAfterRun({ generatedAfterRun: 3, maxOccurrences: null, endDate: '2027-01-31', nextRunDate: '2027-01-25' })).toBe(false)
  })
})
