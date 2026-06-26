import 'server-only'
import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import {
  getSkvApiGwClientId,
  getSkvApiGwClientSecret,
  getSkvRequestTimeoutMs,
  getSkvServiceBaseUrl,
  requireSkvConfigValue,
  type SkvServiceKey,
} from './config'
import { getSkvSysorgAccessToken } from './token'

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

export async function skvSysorgRequest<T = unknown>(options: SkvSysorgRequestOptions): Promise<SkvSysorgResponse<T>> {
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

  await writeApiRequestStart(options, correlationId, url)

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

  return { ok: response.ok, status: response.status, correlationId, data, text, headers: headersOut }
}

async function writeApiRequestStart(options: SkvSysorgRequestOptions, correlationId: string, url: string) {
  if (!options.supabase) return
  await options.supabase.from('skatteverket_api_requests').insert({
    company_id: options.companyId ?? null,
    user_id: options.userId ?? null,
    service: options.service,
    operation: options.operation ?? `${options.method} ${options.path}`,
    environment: null,
    auth_flow: 'ccg_sysorg',
    correlation_id: correlationId,
    request_url: redactUrl(url),
    method: options.method,
    status: 'started',
    request_id: options.requestId ?? null,
  }).then(() => undefined)
}

async function writeApiRequestEnd(
  options: SkvSysorgRequestOptions,
  correlationId: string,
  statusCode: number,
  durationMs: number,
  errorMessage: string | null,
) {
  if (!options.supabase) return
  const status = statusCode >= 200 && statusCode < 300 ? 'succeeded' : 'failed'
  await options.supabase
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
