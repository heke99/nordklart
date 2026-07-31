import { z } from 'zod'

export const YearEndExecutionErrorCodeSchema = z.enum([
  'YE_PREVIEW_NOT_FOUND',
  'YE_PREVIEW_STALE',
  'YE_PREVIEW_ALREADY_EXECUTED',
  'YE_NOT_READY',
  'YE_NO_ACTIVITY',
  'YE_NO_BALANCE_SHEET',
  'YE_ENTITY_TYPE_MISSING',
  'YE_ALREADY_CLOSED',
  'YE_EXECUTION_IN_PROGRESS',
  'YE_NEXT_PERIOD_NOT_CONTIGUOUS',
  'YE_NEXT_PERIOD_HAS_OB',
  'YE_NEXT_PERIOD_HAS_CONFLICTING_OB',
  'YE_CLOSING_INVARIANT',
  'YE_CONTINUITY_FAILED',
  'YE_LEDGER_CHANGED',
  'YE_READINESS_CHANGED',
  'YE_ADJUSTMENTS_CHANGED',
  'YE_UNBALANCED_ADJUSTMENT',
  'YE_DUPLICATE_CLOSING_ENTRY',
  'YE_PERMISSION_DENIED',
  'YE_DATABASE_UNAVAILABLE',
  'YE_RESULT_INVALID',
  'YE_RUN_NOT_COMMITTED',
  'YE_PERIOD_NOT_FOUND',
  'YE_UNKNOWN',
])

export type YearEndExecutionErrorCode = z.infer<typeof YearEndExecutionErrorCodeSchema>

export const YearEndRpcResultSchema = z.object({
  run_id: z.string().uuid(),
  status: z.literal('closed').default('closed'),
  closing_entry_id: z.string().uuid(),
  opening_balance_entry_id: z.string().uuid(),
  next_period_id: z.string().uuid(),
  next_period_created: z.boolean(),
  opening_balance_created: z.boolean(),
  revaluation_entry_id: z.string().uuid().nullable(),
  revaluation_reversal_entry_id: z.string().uuid().nullable(),
  preview_id: z.string().uuid(),
  correlation_id: z.string().nullable().optional(),
  ledger_hash: z.string().min(1),
  readiness_hash: z.string().min(1),
  adjustment_hash: z.string().min(1),
  ruleset_version: z.string().min(1),
  idempotent: z.boolean(),
}).strict()

export type YearEndRpcResult = z.infer<typeof YearEndRpcResultSchema>

const USER_MESSAGES: Record<YearEndExecutionErrorCode, string> = {
  YE_PREVIEW_NOT_FOUND: 'Förhandsgranskningen kunde inte hittas. Skapa en ny förhandsgranskning.',
  YE_PREVIEW_STALE: 'Bokföringen eller bokslutsunderlaget har ändrats. Skapa en ny förhandsgranskning innan bokslutet verkställs.',
  YE_PREVIEW_ALREADY_EXECUTED: 'Förhandsgranskningen har redan verkställts. Det befintliga bokslutsresultatet visas i stället.',
  YE_NOT_READY: 'Bokslutet har blockerande kontroller som måste åtgärdas innan det kan verkställas.',
  YE_NO_ACTIVITY: 'Räkenskapsåret saknar bokförd aktivitet som kan avslutas.',
  YE_NO_BALANCE_SHEET: 'Räkenskapsåret saknar balanskonton som kan föras över till nästa år.',
  YE_ENTITY_TYPE_MISSING: 'Företagets juridiska form saknas. Komplettera företagsuppgifterna innan bokslutet verkställs.',
  YE_ALREADY_CLOSED: 'Räkenskapsåret är redan stängt. Ingen ny bokslutskörning har genomförts.',
  YE_EXECUTION_IN_PROGRESS: 'Ett bokslut håller redan på att verkställas för perioden.',
  YE_NEXT_PERIOD_NOT_CONTIGUOUS: 'Nästa räkenskapsår börjar inte direkt efter det aktuella räkenskapsåret. Kontrollera perioddatumen.',
  YE_NEXT_PERIOD_HAS_OB: 'Nästa räkenskapsår innehåller redan en ingående balans som måste verifieras innan bokslutet kan fortsätta.',
  YE_NEXT_PERIOD_HAS_CONFLICTING_OB: 'Nästa räkenskapsår innehåller en ingående balans som inte stämmer med årets utgående balans.',
  YE_CLOSING_INVARIANT: 'Resultatkontona kunde inte nollställas korrekt. Ingen del av bokslutet har genomförts.',
  YE_CONTINUITY_FAILED: 'Utgående och ingående balanser stämmer inte överens. Ingen del av bokslutet har genomförts.',
  YE_LEDGER_CHANGED: 'Bokföringen har ändrats sedan förhandsgranskningen. Skapa en ny förhandsgranskning.',
  YE_READINESS_CHANGED: 'Bokslutskontrollerna har ändrats sedan förhandsgranskningen. Kör kontrollerna igen.',
  YE_ADJUSTMENTS_CHANGED: 'Bokslutsjusteringarna har ändrats sedan förhandsgranskningen. Skapa en ny förhandsgranskning.',
  YE_UNBALANCED_ADJUSTMENT: 'En bokslutsjustering balanserar inte. Kontrollera dispositioner och övriga bokslutsposter.',
  YE_DUPLICATE_CLOSING_ENTRY: 'Det finns redan ett slutverifikat för räkenskapsåret. Ingen dubblett skapades.',
  YE_PERMISSION_DENIED: 'Du har inte behörighet att verkställa bokslutet för det här företaget.',
  YE_DATABASE_UNAVAILABLE: 'Bokslutet kunde inte verkställas eftersom databasen inte kunde nås. Ingen ny körning startades.',
  YE_RESULT_INVALID: 'Bokslutet kan vara genomfört, men resultatet kunde inte verifieras. Kontrollera körningsstatusen med request-ID:t.',
  YE_RUN_NOT_COMMITTED: 'Bokslutskörningen är inte slutförd och kan ännu inte bekräftas.',
  YE_PERIOD_NOT_FOUND: 'Räkenskapsåret kunde inte hittas för det valda företaget.',
  YE_UNKNOWN: 'Bokslutet kunde inte verkställas. Ingen ofullständig stängning har godkänts.',
}

const RETRYABLE_CODES = new Set<YearEndExecutionErrorCode>([
  'YE_EXECUTION_IN_PROGRESS',
  'YE_DATABASE_UNAVAILABLE',
])

interface DatabaseErrorShape {
  code?: unknown
  message?: unknown
  details?: unknown
  hint?: unknown
}

export class YearEndExecutionError extends Error {
  readonly code: YearEndExecutionErrorCode
  readonly pgCode?: string
  readonly retryable: boolean
  readonly correlationId: string
  readonly userMessage: string
  readonly details?: Record<string, unknown>

  constructor(options: {
    code: YearEndExecutionErrorCode
    correlationId: string
    technicalMessage?: string
    pgCode?: string
    retryable?: boolean
    userMessage?: string
    details?: Record<string, unknown>
    cause?: unknown
  }) {
    super(options.technicalMessage ?? options.code, { cause: options.cause })
    this.name = 'YearEndExecutionError'
    this.code = options.code
    this.pgCode = options.pgCode
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(options.code)
    this.correlationId = options.correlationId
    this.userMessage = options.userMessage ?? USER_MESSAGES[options.code]
    this.details = options.details
  }
}

function parseStructuredDetails(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function codeFromSqlState(pgCode: string | undefined): YearEndExecutionErrorCode {
  if (pgCode === '42501') return 'YE_PERMISSION_DENIED'
  if (pgCode === '40001' || pgCode === '40P01' || pgCode === '55P03') {
    return 'YE_EXECUTION_IN_PROGRESS'
  }
  if (pgCode?.startsWith('08') || pgCode === '57P01' || pgCode === '57014') {
    return 'YE_DATABASE_UNAVAILABLE'
  }
  if (pgCode === '23505') return 'YE_DUPLICATE_CLOSING_ENTRY'
  return 'YE_UNKNOWN'
}

export function mapYearEndDatabaseError(
  error: unknown,
  correlationId: string,
): YearEndExecutionError {
  if (error instanceof YearEndExecutionError) return error

  const value = error && typeof error === 'object'
    ? error as DatabaseErrorShape
    : {}
  const pgCode = typeof value.code === 'string' ? value.code : undefined
  const structured = parseStructuredDetails(value.details)
    ?? parseStructuredDetails(value.hint)
  const parsedCode = YearEndExecutionErrorCodeSchema.safeParse(structured?.code)
  const code = parsedCode.success ? parsedCode.data : codeFromSqlState(pgCode)
  const technicalMessage = typeof value.message === 'string'
    ? value.message
    : error instanceof Error
      ? error.message
      : String(error)

  const safeDetails = structured
    ? Object.fromEntries(Object.entries(structured).filter(([key]) => key !== 'technical_error'))
    : undefined

  return new YearEndExecutionError({
    code,
    correlationId,
    technicalMessage,
    pgCode,
    details: safeDetails,
    cause: error,
  })
}

export function yearEndUserMessage(code: YearEndExecutionErrorCode): string {
  return USER_MESSAGES[code]
}
