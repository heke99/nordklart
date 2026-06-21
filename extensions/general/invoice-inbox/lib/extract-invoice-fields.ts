// Deterministic invoice/receipt extraction.
//
// Documents are sent to Nordklart's OpenDataLoader OCR worker, which returns
// text/Markdown/JSON from the PDF or image. Nordklart then applies its own
// Swedish invoice parser and validation. No Claude, Anthropic or Bedrock call
// is made in this path.

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { InvoiceExtractionResult } from '@/types'
import { createLogger } from '@/lib/logger'
import { runOpenDataLoaderOcr } from '@/lib/ocr/opendataloader-client'
import { parseInvoiceFieldsFromOcr } from '@/lib/extraction/invoice-field-parser'

const log = createLogger('invoice-inbox-extract')

const SUPPORTED_MEDIA_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

export interface ExtractionInput {
  buffer: Buffer
  mimeType: string
  fileName: string
  documentId?: string | null
  companyId?: string | null
}

export interface ExtractionOutput {
  data: InvoiceExtractionResult
  /** OCR text/Markdown used for deterministic parsing, or null on skip/failure. */
  rawText: string | null
}

export const ExtractionSchema = z.object({
  supplier: z.object({
    name: z.string().nullable(),
    orgNumber: z.string().nullable(),
    vatNumber: z.string().nullable(),
    address: z.string().nullable(),
    bankgiro: z.string().nullable(),
    plusgiro: z.string().nullable(),
  }),
  invoice: z.object({
    invoiceNumber: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    paymentReference: z.string().nullable(),
    currency: z.string(),
  }),
  lineItems: z.array(
    z.object({
      description: z.string(),
      quantity: z.number(),
      unitPrice: z.number().nullable(),
      lineTotal: z.number(),
      vatRate: z.number().min(0).max(100).nullable(),
      accountSuggestion: z.union([z.string(), z.null()]).transform(() => null as null),
    })
  ),
  totals: z.object({
    subtotal: z.number().nullable(),
    vatAmount: z.number().nullable(),
    total: z.number().nullable(),
  }),
  vatBreakdown: z.array(
    z.object({
      rate: z.number().min(0).max(100),
      base: z.number(),
      amount: z.number(),
    })
  ),
})

export function emptyResult(): InvoiceExtractionResult {
  return {
    supplier: {
      name: null,
      orgNumber: null,
      vatNumber: null,
      address: null,
      bankgiro: null,
      plusgiro: null,
    },
    invoice: {
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
      paymentReference: null,
      currency: 'SEK',
    },
    lineItems: [],
    totals: { subtotal: null, vatAmount: null, total: null },
    vatBreakdown: [],
    confidence: 0,
  }
}

function fileNameHash(fileName: string): string {
  return createHash('sha256').update(fileName).digest('hex').slice(0, 12)
}

/**
 * Extract invoice fields via OpenDataLoader OCR + Nordklart deterministic
 * parser. Never throws on extraction failure; the caller receives an empty
 * result and can let the user fill fields manually.
 */
export async function extractInvoiceFields(input: ExtractionInput): Promise<ExtractionOutput> {
  if (!SUPPORTED_MEDIA_TYPES.has(input.mimeType)) {
    log.warn('Unsupported document type for OCR extraction', {
      file_name_hash: fileNameHash(input.fileName),
      mimeType: input.mimeType,
    })
    return { data: emptyResult(), rawText: null }
  }

  const ocr = await runOpenDataLoaderOcr({
    buffer: input.buffer,
    mimeType: input.mimeType,
    fileName: input.fileName,
    documentId: input.documentId,
    companyId: input.companyId,
  })

  if (ocr.status !== 'succeeded') {
    return { data: emptyResult(), rawText: null }
  }

  try {
    const parsed = parseInvoiceFieldsFromOcr({
      text: ocr.text,
      markdown: ocr.markdown,
      fileName: input.fileName,
    })

    const validated = ExtractionSchema.parse(parsed.data)
    return {
      data: { ...validated, confidence: parsed.data.confidence },
      rawText: parsed.rawText,
    }
  } catch (err) {
    log.warn('Deterministic OCR parsing failed', {
      file_name_hash: fileNameHash(input.fileName),
      mimeType: input.mimeType,
      error: err instanceof Error ? err.message : String(err),
    })
    return { data: emptyResult(), rawText: null }
  }
}
