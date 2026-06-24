import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractInvoiceFields } from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'

const mocks = vi.hoisted(() => ({
  runOcr: vi.fn(),
  parse: vi.fn(),
}))

vi.mock('@/lib/ocr/opendataloader-client', () => ({
  runOpenDataLoaderOcr: mocks.runOcr,
}))

vi.mock('@/lib/extraction/invoice-field-parser', () => ({
  parseInvoiceFieldsFromOcr: mocks.parse,
}))

const mockRunOcr = mocks.runOcr
const mockParse = mocks.parse

const VALID_RESULT = {
  supplier: {
    name: 'Anthropic, PBC',
    orgNumber: null,
    vatNumber: null,
    address: '548 Market Street, San Francisco, CA 94104',
    bankgiro: null,
    plusgiro: null,
  },
  invoice: {
    invoiceNumber: '06655767-0007',
    invoiceDate: '2026-02-13',
    dueDate: null,
    paymentReference: null,
    currency: 'USD',
  },
  lineItems: [
    {
      description: 'One-time credit purchase',
      quantity: 1,
      unitPrice: 5,
      lineTotal: 5,
      vatRate: 25,
      accountSuggestion: null,
    },
  ],
  totals: { subtotal: 5, vatAmount: 1.25, total: 6.25 },
  vatBreakdown: [{ rate: 25, base: 5, amount: 1.25 }],
  confidence: 1,
}

describe('extractInvoiceFields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunOcr.mockResolvedValue({
      status: 'succeeded',
      text: 'Anthropic invoice text',
      markdown: '# Anthropic',
    })
    mockParse.mockReturnValue({ data: VALID_RESULT, rawText: 'Anthropic invoice text' })
  })

  it('returns empty result for unsupported mime type (HEIC)', async () => {
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from(''),
      mimeType: 'image/heic',
      fileName: 'photo.heic',
    })
    expect(rawText).toBeNull()
    expect(data.totals.total).toBeNull()
    expect(data.supplier.name).toBeNull()
    expect(mockRunOcr).not.toHaveBeenCalled()
  })

  it('parses deterministic OCR output into InvoiceExtractionResult', async () => {
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'anthropic-receipt.pdf',
      documentId: 'doc-1',
      companyId: 'company-1',
    })
    expect(rawText).toContain('Anthropic')
    expect(data.supplier.name).toBe('Anthropic, PBC')
    expect(data.invoice.currency).toBe('USD')
    expect(data.invoice.invoiceNumber).toBe('06655767-0007')
    expect(data.totals.total).toBe(6.25)
    expect(data.vatBreakdown).toHaveLength(1)
    expect(data.lineItems).toHaveLength(1)
    expect(data.confidence).toBe(1)
    expect(mockRunOcr).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'application/pdf',
      fileName: 'anthropic-receipt.pdf',
      documentId: 'doc-1',
      companyId: 'company-1',
    }))
  })

  it('passes image uploads to the OCR worker', async () => {
    await extractInvoiceFields({
      buffer: Buffer.from('JPEG'),
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
    })
    expect(mockRunOcr).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
    }))
  })

  it('passes PDF uploads to the OCR worker', async () => {
    await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
    })
    expect(mockRunOcr).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'application/pdf',
      fileName: 'invoice.pdf',
    }))
  })

  it('returns empty result when OCR fails', async () => {
    mockRunOcr.mockResolvedValueOnce({ status: 'failed', text: null, markdown: null })
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(rawText).toBeNull()
    expect(data.totals.total).toBeNull()
    expect(data.supplier.name).toBeNull()
    expect(mockParse).not.toHaveBeenCalled()
  })

  it('returns empty result when deterministic parsing fails schema validation', async () => {
    mockParse.mockReturnValueOnce({ data: { supplier: { name: 'X' } }, rawText: 'bad' })
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(rawText).toBeNull()
    expect(data.totals.total).toBeNull()
    expect(data.supplier.name).toBeNull()
  })

  it('returns empty result when OCR worker throws', async () => {
    mockRunOcr.mockRejectedValueOnce(new Error('worker down'))
    const { data, rawText } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(rawText).toBeNull()
    expect(data.totals.total).toBeNull()
  })

  it('forces accountSuggestion to null even if the parser returns a value', async () => {
    mockParse.mockReturnValueOnce({
      data: {
        ...VALID_RESULT,
        lineItems: [{ ...VALID_RESULT.lineItems[0], accountSuggestion: '5410' }],
      },
      rawText: 'Anthropic invoice text',
    })
    const { data } = await extractInvoiceFields({
      buffer: Buffer.from('%PDF'),
      mimeType: 'application/pdf',
      fileName: 'f.pdf',
    })
    expect(data.lineItems[0].accountSuggestion).toBeNull()
  })
})
