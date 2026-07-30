import { describe, expect, it } from 'vitest'
import {
  getYearEndApiErrorMessage,
  parseYearEndApiError,
} from '@/lib/year-end/api-error'

describe('year-end API error parser', () => {
  it('prefers the canonical nested message and keeps diagnostics', () => {
    expect(parseYearEndApiError({
      error: {
        code: 'YEAR_END_RULESET_MISSING',
        message: 'Regelverk saknas.',
        action: 'contact_support',
      },
      requestId: 'req-123',
    }, 'Reserv', 422)).toEqual({
      message: 'Regelverk saknas.',
      code: 'YEAR_END_RULESET_MISSING',
      status: 422,
      requestId: 'req-123',
      action: 'contact_support',
      details: undefined,
    })
  })

  it('supports legacy top-level errors without hiding the real message', () => {
    expect(getYearEndApiErrorMessage({
      error: 'FEATURE_NOT_ENABLED',
      message: 'Bokslutet är inte köpt för perioden.',
      request_id: 'req-legacy',
    }, 'Kunde inte ladda', 403)).toBe(
      'Bokslutet är inte köpt för perioden. (felkod FEATURE_NOT_ENABLED, request-ID req-legacy)',
    )
  })

  it('uses details before the fallback and tolerates non-object bodies', () => {
    expect(parseYearEndApiError(
      { details: 'Databasen kunde inte verifiera saldot.' },
      'Reserv',
      500,
    ).message).toBe('Databasen kunde inte verifiera saldot.')
    expect(parseYearEndApiError(null, 'Reserv').message).toBe('Reserv')
  })
})
