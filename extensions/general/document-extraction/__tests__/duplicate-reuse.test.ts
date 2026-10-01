import { describe, it, expect, vi, beforeEach } from 'vitest'

// Each from() call takes the next scripted result; update() payloads are recorded.
const results: Array<{ data: unknown; error: unknown }> = []
const updates: Array<Record<string, unknown>> = []
function chain(result: { data: unknown; error: unknown }): unknown {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
      if (prop === 'update') {
        return (payload: Record<string, unknown>) => {
          updates.push(payload)
          return chain({ data: null, error: null })
        }
      }
      return () => chain(result)
    },
  })
}
const download = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => chain(results.shift() ?? { data: null, error: null }),
    storage: { from: () => ({ download }) },
  }),
}))

const extractInvoiceFields = vi.fn()
vi.mock('@/extensions/general/invoice-inbox/lib/extract-invoice-fields', () => ({
  extractInvoiceFields: (...args: unknown[]) => extractInvoiceFields(...args),
}))

import { documentExtractionExtension } from '../index'

const handler = documentExtractionExtension.eventHandlers![0].handler
const doc = { id: 'doc-2', file_name: 'kvitto.pdf' }
const existingRow = { id: 'doc-2', mime_type: 'application/pdf', storage_path: 'c1/kvitto.pdf', extracted_at: null, sha256_hash: 'abc' }

beforeEach(() => {
  vi.clearAllMocks()
  results.length = 0
  updates.length = 0
})

describe('document-extraction duplicate reuse', () => {
  it('copies the result of an identical file already read in the company instead of running OCR', async () => {
    results.push(
      { data: existingRow, error: null }, // the uploaded row
      { data: null, error: null }, // no invoice-inbox row
      { data: { extracted_data: { supplier: { name: 'Leverantör AB' } } }, error: null }, // same hash, already read
    )
    await handler({ document: doc, userId: 'u', companyId: 'c1' } as never, {} as never)

    expect(extractInvoiceFields).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(updates.at(-1)).toMatchObject({
      extracted_data: { supplier: { name: 'Leverantör AB' } },
      extraction_model: 'copied-from-duplicate',
    })
  })

  it('runs OCR when no identical file has been read', async () => {
    results.push(
      { data: existingRow, error: null },
      { data: null, error: null },
      { data: null, error: null }, // no duplicate
    )
    download.mockResolvedValue({ data: new Blob(['pdf']), error: null })
    extractInvoiceFields.mockResolvedValue({ data: { supplier: { name: 'Ny AB' } }, rawText: 'text' })
    await handler({ document: doc, userId: 'u', companyId: 'c1' } as never, {} as never)

    expect(extractInvoiceFields).toHaveBeenCalledTimes(1)
    expect(updates.at(-1)).toMatchObject({ extraction_model: 'opendataloader_pdf:v1' })
  })
})
