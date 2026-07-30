export interface YearEndApiError {
  message: string
  code?: string
  status?: number
  requestId?: string
  action?: string
  details?: unknown
}

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object'
    ? value as UnknownRecord
    : null
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

/**
 * Normalizes every response shape used by the year-end APIs. The parser is
 * deliberately client-safe so every wizard step can surface the same
 * localized message, stable code and request id instead of replacing the
 * backend error with a generic fallback.
 */
export function parseYearEndApiError(
  body: unknown,
  fallbackMessage: string,
  status?: number,
): YearEndApiError {
  const root = asRecord(body)
  const nestedError = asRecord(root?.error)

  const message =
    asNonEmptyString(nestedError?.message)
    ?? asNonEmptyString(root?.message)
    ?? asNonEmptyString(root?.error)
    ?? asNonEmptyString(root?.details)
    ?? fallbackMessage

  return {
    message,
    code:
      asNonEmptyString(nestedError?.code)
      ?? asNonEmptyString(root?.code)
      ?? (typeof root?.error === 'string'
        ? asNonEmptyString(root.error)
        : undefined),
    status,
    requestId:
      asNonEmptyString(nestedError?.requestId)
      ?? asNonEmptyString(nestedError?.request_id)
      ?? asNonEmptyString(root?.requestId)
      ?? asNonEmptyString(root?.request_id),
    action:
      asNonEmptyString(nestedError?.action)
      ?? asNonEmptyString(root?.action),
    details: nestedError?.details ?? root?.details,
  }
}

export function formatYearEndApiError(error: YearEndApiError): string {
  const references: string[] = []
  if (error.code && error.code !== error.message) {
    references.push(`felkod ${error.code}`)
  }
  if (error.requestId) {
    references.push(`request-ID ${error.requestId}`)
  }
  return references.length > 0
    ? `${error.message} (${references.join(', ')})`
    : error.message
}

export function getYearEndApiErrorMessage(
  body: unknown,
  fallbackMessage: string,
  status?: number,
): string {
  return formatYearEndApiError(parseYearEndApiError(body, fallbackMessage, status))
}
