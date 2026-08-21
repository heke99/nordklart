import 'server-only'
import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import {
  getSkvApiGwClientId,
  getSkvApiGwClientSecret,
  getSkvEnvironment,
  getSkvRequestTimeoutMs,
  getSkvServiceBaseUrl,
  requireSkvConfigValue,
  type SkvServiceKey,
} from './config'
import { getSkvSysorgAccessToken } from './token'
import { recordSkvOmbudObservation, verdictFromResponse } from '@/lib/skatteverket/ombud'
import { decideSkvRetry, parseRetryAfter, SKV_MAX_ATTEMPTS } from '@/lib/skatteverket/retry'

const log = createLogger('skv-sysorg-client')
let lastRequestAt = 0
const MIN_REQUEST_INTERVAL_MS = 250

export type SkvSysorgRequestOptions = {
  service: SkvServiceKey
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
  contentType?: string
  accept?: string
  operation?: string
  supabase?: SupabaseClient
  companyId?: string | null
  userId?: string | null
  requestId?: string | null
  /**
   * Groups the attempts of one logical operation in
   * `skatteverket_api_requests`. Generated per call when omitted.
   */
  idempotencyKey?: string | null
}

export type SkvSysorgResponse<T = unknown> = {
  ok: boolean
  status: number
  correlationId: string
  data: T | null
  text: string
  headers: Record<string, string>
}

async function enforceSkvRateLimit() {
  const now = Date.now()
  const wait = MIN_REQUEST_INTERVAL_MS - (now - lastRequestAt)
  lastRequestAt = now
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
}

/**
 * One Skatteverket call, with a bounded retry around it.
 *
 * The retry lives here rather than in each caller so the policy is applied
 * once and recorded once: every attempt gets its own row in
 * `skatteverket_api_requests`, all attempts of one call share an
 * `idempotency_key`, and a failed attempt that will be retried carries the
 * `next_retry_at` it is waiting for. `decideSkvRetry` refuses to repeat a POST
 * — Skatteverket has no idempotency header, so a retried filing can become two.
 */
export async function skvSysorgRequest<T = unknown>(options: SkvSysorgRequestOptions): Promise<SkvSysorgResponse<T>> {
  const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID()
  let lastError: unknown

  for (let attempt = 1; attempt <= SKV_MAX_ATTEMPTS; attempt += 1) {
    let outcome: Awaited<ReturnType<typeof skvSysorgAttempt<T>>>
    try {
      outcome = await skvSysorgAttempt<T>(options, idempotencyKey, attempt)
    } catch (err) {
      lastError = err
      // The request never produced a response — timeout or connection failure.
      const decision = decideSkvRetry({ method: options.method, statusCode: 0, attempt })
      if (!decision.retry) throw err
      await markRetryPending(options, attempt, idempotencyKey, decision.delayMs)
      await sleep(decision.delayMs)
      continue
    }

    if (outcome.response.ok) return outcome.response

    const decision = decideSkvRetry({
      method: options.method,
      statusCode: outcome.response.status,
      attempt,
      retryAfterSeconds: outcome.retryAfterSeconds,
    })
    if (!decision.retry) return outcome.response

    await markRetryPending(options, attempt, idempotencyKey, decision.delayMs)
    await sleep(decision.delayMs)
  }

  // Only reachable when the last attempt threw and the loop ran out.
  throw lastError instanceof Error
    ? lastError
    : new Error('Skatteverket-anropet misslyckades efter alla försök.')
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

async function skvSysorgAttempt<T>(
  options: SkvSysorgRequestOptions,
  idempotencyKey: string,
  attempt: number,
): Promise<{ response: SkvSysorgResponse<T>; retryAfterSeconds: number | null }> {
  const startedAt = Date.now()
  const correlationId = crypto.randomUUID()
  const accessToken = await getSkvSysorgAccessToken()
  const apiGwClientId = requireSkvConfigValue(getSkvApiGwClientId(), 'SKV_APIGW_CLIENT_ID')
  const apiGwClientSecret = requireSkvConfigValue(getSkvApiGwClientSecret(), 'SKV_APIGW_CLIENT_SECRET')

  await enforceSkvRateLimit()

  const baseUrl = getSkvServiceBaseUrl(options.service).replace(/\/+$/, '')
  const path = options.path.startsWith('/') ? options.path : `/${options.path}`
  const url = `${baseUrl}${path}`

  const headers: Record<string, string> = {
    Authorization: `${accessToken.tokenType} ${accessToken.accessToken}`,
    Client_Id: apiGwClientId,
    Client_Secret: apiGwClientSecret,
    skv_client_correlation_id: correlationId,
  }
  if (options.accept) headers.Accept = options.accept

  let body: BodyInit | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = options.contentType ?? 'application/json'
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  }

  await writeApiRequestStart(options, correlationId, url, idempotencyKey, attempt)

  let response: Response
  try {
    response = await fetch(url, {
      method: options.method,
      headers,
      body,
      signal: AbortSignal.timeout(getSkvRequestTimeoutMs()),
    })
  } catch (err) {
    await writeApiRequestEnd(options, correlationId, 0, Date.now() - startedAt, err instanceof Error ? err.message : 'Network error')
    throw err
  }

  const text = await response.text().catch(() => '')
  const headersOut: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    if (['content-type', 'x-request-id', 'x-amzn-requestid'].includes(key.toLowerCase())) headersOut[key] = value
  })

  await writeApiRequestEnd(options, correlationId, response.status, Date.now() - startedAt, response.ok ? null : text.slice(0, 500))

  let data: T | null = null
  if (text && (response.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      data = JSON.parse(text) as T
    } catch {
      data = null
    }
  }

  if (!response.ok) {
    log.warn('Skatteverket sysorg request failed', {
      service: options.service,
      operation: options.operation,
      status: response.status,
      correlationId,
      body: text.slice(0, 300),
    })
  }

  return {
    response: { ok: response.ok, status: response.status, correlationId, data, text, headers: headersOut },
    retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
  }
}

/**
 * Marks the attempt that just failed with when the next one is due.
 *
 * `next_retry_at` is on the failed attempt's own row, not on a separate queue:
 * the row already says which operation and which attempt this was, and the
 * CHECK constraint keeps the field meaningless on anything but a failure.
 */
async function markRetryPending(
  options: SkvSysorgRequestOptions,
  attempt: number,
  idempotencyKey: string,
  delayMs: number,
) {
  const auditClient = await resolveAuditClient(options)
  if (!auditClient) return
  await auditClient
    .from('skatteverket_api_requests')
    .update({ next_retry_at: new Date(Date.now() + delayMs).toISOString() })
    .eq('idempotency_key', idempotencyKey)
    .eq('attempt_count', attempt)
    .then(() => undefined)
}

/**
 * Audit rows are written with the SERVICE client: the table's RLS makes it
 * append-only from the server's perspective (members read, never write), so
 * a user session can neither forge nor mutate the Skatteverket audit trail.
 * Falls back to the caller's client when the service client is unavailable
 * (unit tests without env).
 */
async function resolveAuditClient(options: SkvSysorgRequestOptions): Promise<SupabaseClient | null> {
  if (!options.supabase) return null
  try {
    const { createServiceClient } = await import('@/lib/supabase/server')
    return createServiceClient()
  } catch {
    return options.supabase
  }
}

async function writeApiRequestStart(
  options: SkvSysorgRequestOptions,
  correlationId: string,
  url: string,
  idempotencyKey: string,
  attempt: number,
) {
  const auditClient = await resolveAuditClient(options)
  if (!auditClient) return
  await auditClient.from('skatteverket_api_requests').insert({
    company_id: options.companyId ?? null,
    user_id: options.userId ?? null,
    service: options.service,
    operation: options.operation ?? `${options.method} ${options.path}`,
    // The audit row must record WHICH Skatteverket environment the request
    // targeted — indispensable when investigating a filing after the fact.
    environment: getSkvEnvironment(),
    auth_flow: 'ccg_sysorg',
    correlation_id: correlationId,
    request_url: redactUrl(url),
    method: options.method,
    status: 'started',
    request_id: options.requestId ?? null,
    idempotency_key: idempotencyKey,
    attempt_count: attempt,
  }).then(() => undefined)
}

async function writeApiRequestEnd(
  options: SkvSysorgRequestOptions,
  correlationId: string,
  statusCode: number,
  durationMs: number,
  errorMessage: string | null,
) {
  const auditClient = await resolveAuditClient(options)
  if (!auditClient) return
  const status = statusCode >= 200 && statusCode < 300 ? 'succeeded' : 'failed'
  await auditClient
    .from('skatteverket_api_requests')
    .update({
      status,
      status_code: statusCode || null,
      duration_ms: durationMs,
      error_message: errorMessage,
      finished_at: new Date().toISOString(),
    })
    .eq('correlation_id', correlationId)
    .then(() => undefined)

  // The organisation certificate authorises the systemorganisation, not the
  // right to act for a given company — that still comes from the customer's
  // ombud registration, and the only place it is observable is in what SKV
  // answers. Same rule as the per-BankID track (lib/skatteverket/ombud.ts):
  // a success is a yes, a behörighet refusal is a no, everything else is not a
  // verdict.
  const authorized = verdictFromResponse(statusCode, errorMessage)
  if (authorized !== null && options.companyId) {
    await recordSkvOmbudObservation({
      companyId: options.companyId,
      authFlow: 'ccg_sysorg',
      authorized,
      correlationId,
      statusCode,
      operation: options.operation ?? `${options.method} ${options.path}`,
    })
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.search = ''
    return parsed.toString()
  } catch {
    return url.split('?')[0]
  }
}
