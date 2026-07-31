import { describe, expect, it } from 'vitest'
import {
  YearEndExecutionError,
  YearEndRpcResultSchema,
  mapYearEndDatabaseError,
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
