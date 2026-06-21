import { createHash, createHmac } from 'node:crypto'
import { createLogger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'

const log = createLogger('opendataloader-ocr')

const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_MAX_FILE_MB = 10

const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

export interface OpenDataLoaderOcrInput {
  buffer: Buffer
  mimeType: string
  fileName: string
  documentId?: string | null
  companyId?: string | null
  mode?: 'pdf_or_ocr' | 'force_ocr'
  languageHint?: string | null
}

export interface OpenDataLoaderOcrResult {
  status: 'succeeded' | 'failed' | 'skipped'
  provider: 'opendataloader_pdf'
  mode: string
  text: string | null
  markdown: string | null
  json: Record<string, unknown> | null
  pageCount: number | null
  errorCode: string | null
  errorMessage: string | null
  raw: Record<string, unknown> | null
}

function isConfigured(): boolean {
  return Boolean(process.env.OCR_SERVICE_URL && process.env.OCR_SERVICE_HMAC_SECRET)
}

function fileNameHash(fileName: string): string {
  return createHash('sha256').update(fileName).digest('hex').slice(0, 12)
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

async function persistOcrRun(
  input: OpenDataLoaderOcrInput,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!input.documentId || !input.companyId) return
  try {
    const supabase = createServiceClient()
    await supabase
      .from('document_ocr_runs')
      .upsert({
        company_id: input.companyId,
        document_id: input.documentId,
        provider: 'opendataloader_pdf',
        mode: input.mode ?? process.env.OCR_MODE ?? 'pdf_or_ocr',
        input_mime_type: input.mimeType,
        input_file_size_bytes: input.buffer.byteLength,
        input_sha256_hash: createHash('sha256').update(input.buffer).digest('hex'),
        language_hint: input.languageHint ?? process.env.OCR_DEFAULT_LANG ?? 'sv,en',
        ...patch,
      }, { onConflict: 'document_id,provider,mode' })
  } catch (err) {
    log.warn('Failed to persist OCR run', {
      document_id: input.documentId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function skipped(input: OpenDataLoaderOcrInput, errorCode: string, errorMessage: string): Promise<OpenDataLoaderOcrResult> {
  log.warn('OCR skipped', {
    file_name_hash: fileNameHash(input.fileName),
    mime_type: input.mimeType,
    error_code: errorCode,
  })
  await persistOcrRun(input, {
    status: 'skipped',
    started_at: null,
    completed_at: new Date().toISOString(),
    error_code: errorCode,
    error_message: errorMessage,
  })
  return {
    status: 'skipped',
    provider: 'opendataloader_pdf',
    mode: input.mode ?? 'pdf_or_ocr',
    text: null,
    markdown: null,
    json: null,
    pageCount: null,
    errorCode,
    errorMessage,
    raw: null,
  }
}

async function failed(input: OpenDataLoaderOcrInput, errorCode: string, errorMessage: string): Promise<OpenDataLoaderOcrResult> {
  log.warn('OCR failed', {
    file_name_hash: fileNameHash(input.fileName),
    mime_type: input.mimeType,
    error_code: errorCode,
    error_message: errorMessage,
  })
  await persistOcrRun(input, {
    status: 'failed',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    error_code: errorCode,
    error_message: errorMessage,
  })
  return {
    status: 'failed',
    provider: 'opendataloader_pdf',
    mode: input.mode ?? 'pdf_or_ocr',
    text: null,
    markdown: null,
    json: null,
    pageCount: null,
    errorCode,
    errorMessage,
    raw: null,
  }
}

export async function runOpenDataLoaderOcr(input: OpenDataLoaderOcrInput): Promise<OpenDataLoaderOcrResult> {
  if (!SUPPORTED_MIME_TYPES.has(input.mimeType)) {
    return await skipped(input, 'unsupported_mime_type', `Unsupported OCR mime type: ${input.mimeType}`)
  }

  if (!isConfigured()) {
    return await skipped(input, 'ocr_not_configured', 'OCR_SERVICE_URL and OCR_SERVICE_HMAC_SECRET must be configured')
  }

  const maxBytes = readPositiveIntEnv('OCR_MAX_FILE_MB', DEFAULT_MAX_FILE_MB) * 1024 * 1024
  if (input.buffer.byteLength > maxBytes) {
    return await skipped(input, 'file_too_large', `File exceeds OCR_MAX_FILE_MB (${Math.round(maxBytes / 1024 / 1024)} MB)`)
  }

  const serviceUrl = process.env.OCR_SERVICE_URL!.replace(/\/$/, '')
  const secret = process.env.OCR_SERVICE_HMAC_SECRET!
  const timeoutMs = readPositiveIntEnv('OCR_REQUEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
  const body = JSON.stringify({
    document_id: input.documentId ?? null,
    company_id: input.companyId ?? null,
    file_name: input.fileName,
    mime_type: input.mimeType,
    content_base64: input.buffer.toString('base64'),
    mode: input.mode ?? process.env.OCR_MODE ?? 'pdf_or_ocr',
    language_hint: input.languageHint ?? process.env.OCR_DEFAULT_LANG ?? 'sv,en',
  })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

  const startedAt = new Date().toISOString()
  await persistOcrRun(input, {
    status: 'running',
    started_at: startedAt,
    completed_at: null,
    error_code: null,
    error_message: null,
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${serviceUrl}/v1/ocr`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nordklart-timestamp': timestamp,
        'x-nordklart-signature': signature,
      },
      body,
      signal: controller.signal,
    })

    const raw = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      return await failed(
        input,
        typeof raw?.error_code === 'string' ? raw.error_code : `http_${response.status}`,
        typeof raw?.error_message === 'string' ? raw.error_message : response.statusText,
      )
    }

    const text = typeof raw?.text === 'string' ? raw.text : null
    const markdown = typeof raw?.markdown === 'string' ? raw.markdown : null
    const json = raw?.json && typeof raw.json === 'object' && !Array.isArray(raw.json)
      ? raw.json as Record<string, unknown>
      : null
    const pageCount = typeof raw?.page_count === 'number' ? raw.page_count : null

    if (!text && !markdown && !json) {
      return await failed(input, 'empty_ocr_result', 'OpenDataLoader returned no text, markdown or json')
    }

    await persistOcrRun(input, {
      status: 'succeeded',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      output_text: text,
      output_markdown: markdown,
      output_json: json,
      page_count: pageCount,
      error_code: null,
      error_message: null,
    })

    return {
      status: 'succeeded',
      provider: 'opendataloader_pdf',
      mode: typeof raw?.mode === 'string' ? raw.mode : input.mode ?? 'pdf_or_ocr',
      text,
      markdown,
      json,
      pageCount,
      errorCode: null,
      errorMessage: null,
      raw,
    }
  } catch (err) {
    return await failed(
      input,
      err instanceof Error && err.name === 'AbortError' ? 'ocr_timeout' : 'ocr_request_failed',
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    clearTimeout(timeout)
  }
}
