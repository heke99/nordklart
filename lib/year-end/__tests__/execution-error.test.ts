import { describe, expect, it } from 'vitest'
import {
  YearEndExecutionError,
  YearEndExecutionErrorCodeSchema,
  YearEndRpcResultSchema,
  mapYearEndDatabaseError,
  yearEndUserMessage,
} from '@/lib/year-end/execution-error'

const validResult = {
  run_id: '11111111-1111-4111-8111-111111111111',
  status: 'closed',
  closing_entry_id: '22222222-2222-4222-8222-222222222222',
  opening_balance_entry_id: '33333333-3333-4333-8333-333333333333',
  next_period_id: '44444444-4444-4444-8444-444444444444',
  next_period_created: true,
  opening_balance_created: true,
  revaluation_entry_id: null,
  revaluation_reversal_entry_id: null,
  preview_id: '55555555-5555-4555-8555-555555555555',
  correlation_id: 'req-test',
  ledger_hash: 'ledger',
  readiness_hash: 'readiness',
  adjustment_hash: 'adjustments',
  ruleset_version: 'se-2025-v1',
  idempotent: false,
}

describe('YearEndRpcResultSchema', () => {
  it('accepts the complete database-owned execution result', () => {
    expect(YearEndRpcResultSchema.parse(validResult)).toEqual(validResult)
  })

  it('rejects guessed or incomplete results', () => {
    expect(YearEndRpcResultSchema.safeParse({
      ...validResult,
      next_period_created: undefined,
    }).success).toBe(false)
    expect(YearEndRpcResultSchema.safeParse({
      ...validResult,
      unexpected: true,
    }).success).toBe(false)
  })
})

describe('mapYearEndDatabaseError', () => {
  it('uses the structured database detail instead of matching message text', () => {
    const mapped = mapYearEndDatabaseError({
      code: '55000',
      message: 'localized or changed database text',
      details: JSON.stringify({ code: 'YE_NEXT_PERIOD_NOT_CONTIGUOUS' }),
    }, 'req-1')
    expect(mapped).toBeInstanceOf(YearEndExecutionError)
    expect(mapped.code).toBe('YE_NEXT_PERIOD_NOT_CONTIGUOUS')
    expect(mapped.correlationId).toBe('req-1')
    expect(mapped.retryable).toBe(false)
  })

  it('maps connection SQLSTATE classes to a retryable database error', () => {
    const mapped = mapYearEndDatabaseError({
      code: '08006',
      message: 'connection failure',
    }, 'req-2')
    expect(mapped.code).toBe('YE_DATABASE_UNAVAILABLE')
    expect(mapped.retryable).toBe(true)
  })

  it('maps permission SQLSTATE without exposing database text to the user', () => {
    const mapped = mapYearEndDatabaseError({
      code: '42501',
      message: 'internal role details',
    }, 'req-3')
    expect(mapped.code).toBe('YE_PERMISSION_DENIED')
    expect(mapped.userMessage).not.toContain('internal role details')
  })
})

describe('mapYearEndDatabaseError — the codes nothing else covered', () => {
  it('maps serialization, deadlock and lock-timeout to a retryable in-progress error', () => {
    // All three mean "another close is holding the period", not "this close is
    // invalid". Reporting them as a hard failure would tell the user their
    // year-end broke when the right answer is to try again.
    for (const pgCode of ['40001', '40P01', '55P03']) {
      const mapped = mapYearEndDatabaseError({ code: pgCode, message: 'lock' }, 'req')
      expect(mapped.code, `SQLSTATE ${pgCode}`).toBe('YE_EXECUTION_IN_PROGRESS')
      expect(mapped.retryable).toBe(true)
    }
  })

  it('maps a unique violation to the duplicate closing entry code', () => {
    const mapped = mapYearEndDatabaseError({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    }, 'req')
    expect(mapped.code).toBe('YE_DUPLICATE_CLOSING_ENTRY')
    expect(mapped.retryable).toBe(false)
  })

  it('maps statement timeout and admin shutdown to database unavailable', () => {
    for (const pgCode of ['57014', '57P01']) {
      expect(mapYearEndDatabaseError({ code: pgCode }, 'req').code).toBe('YE_DATABASE_UNAVAILABLE')
    }
  })

  it('falls back to YE_UNKNOWN only for genuinely unrecognised failures', () => {
    // YE_UNKNOWN is the last resort. Its user message promises that no partial
    // close was accepted, so anything that maps here must be a failure the
    // database refused outright rather than one we simply failed to classify.
    const mapped = mapYearEndDatabaseError({
      code: '22P02',
      message: 'invalid input syntax for type uuid',
    }, 'req-unknown')
    expect(mapped.code).toBe('YE_UNKNOWN')
    expect(mapped.retryable).toBe(false)
    expect(mapped.userMessage).toContain('Ingen ofullständig stängning')
  })

  it('falls back to YE_UNKNOWN for an error with no SQLSTATE at all', () => {
    expect(mapYearEndDatabaseError(new Error('socket hang up'), 'req').code).toBe('YE_UNKNOWN')
    expect(mapYearEndDatabaseError(null, 'req').code).toBe('YE_UNKNOWN')
    expect(mapYearEndDatabaseError('a bare string', 'req').code).toBe('YE_UNKNOWN')
  })

  it('prefers a structured code over the SQLSTATE fallback', () => {
    // A database that raised 23505 while telling us exactly what went wrong
    // must be believed over the generic unique-violation mapping.
    const mapped = mapYearEndDatabaseError({
      code: '23505',
      details: JSON.stringify({ code: 'YE_ALREADY_CLOSED' }),
    }, 'req')
    expect(mapped.code).toBe('YE_ALREADY_CLOSED')
  })

  it('reads the structured code from hint when details is not JSON', () => {
    const mapped = mapYearEndDatabaseError({
      code: '55000',
      details: 'not json at all',
      hint: JSON.stringify({ code: 'YE_NOT_READY' }),
    }, 'req')
    expect(mapped.code).toBe('YE_NOT_READY')
  })

  it('ignores a structured code that is not a known year-end code', () => {
    // An unrecognised code must not be passed through as if it were part of
    // the contract — clients map on this enum.
    const mapped = mapYearEndDatabaseError({
      code: '55000',
      details: JSON.stringify({ code: 'SOMETHING_INVENTED' }),
    }, 'req')
    expect(mapped.code).toBe('YE_UNKNOWN')
  })

  it('strips technical_error from the details it exposes', () => {
    // Internal SQL and driver text must not reach the client through the
    // structured details channel.
    const mapped = mapYearEndDatabaseError({
      code: '55000',
      details: JSON.stringify({
        code: 'YE_NOT_READY',
        blocker_count: 2,
        technical_error: 'PL/pgSQL function execute_year_end_closing line 812',
      }),
    }, 'req')
    expect(mapped.code).toBe('YE_NOT_READY')
    expect(mapped.details).toEqual({ code: 'YE_NOT_READY', blocker_count: 2 })
    expect(JSON.stringify(mapped.details)).not.toContain('PL/pgSQL')
  })

  it('keeps the technical message on the error but out of the user message', () => {
    const mapped = mapYearEndDatabaseError({
      code: '55000',
      message: 'relation "internal_staging" does not exist',
      details: JSON.stringify({ code: 'YE_NOT_READY' }),
    }, 'req')
    expect(mapped.message).toContain('internal_staging')
    expect(mapped.userMessage).not.toContain('internal_staging')
  })

  it('returns an existing YearEndExecutionError unchanged', () => {
    const original = new YearEndExecutionError({ code: 'YE_NOT_READY', correlationId: 'req' })
    expect(mapYearEndDatabaseError(original, 'other-req')).toBe(original)
  })

  it('gives every code a distinct non-empty Swedish user message', () => {
    // A duplicated message means two different failures read identically to
    // the user, which is how "bokslutet misslyckades" became unactionable.
    const codes = YearEndExecutionErrorCodeSchema.options
    const messages = codes.map((code) => yearEndUserMessage(code))
    for (const [index, message] of messages.entries()) {
      expect(message, codes[index]).toBeTruthy()
    }
    expect(new Set(messages).size).toBe(codes.length)
  })
})
