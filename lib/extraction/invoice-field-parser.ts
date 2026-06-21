import type { InvoiceExtractionResult, ExtractedInvoiceLineItem, VatBreakdownItem } from '@/types'

export interface ParsedInvoiceFields {
  data: InvoiceExtractionResult
  rawText: string | null
}

const DATE_LABELS = [
  'fakturadatum',
  'invoice date',
  'datum',
  'date',
]

const DUE_DATE_LABELS = [
  'förfallodatum',
  'forfallodatum',
  'förfaller',
  'betalas senast',
  'due date',
  'payment due',
]

function emptyExtractionResult(): InvoiceExtractionResult {
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

function normaliseText(input: string | null | undefined): string {
  return String(input ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function removeDiacritics(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseAmount(raw: string | null | undefined): number | null {
  if (!raw) return null
  let value = raw
    .replace(/\s/g, '')
    .replace(/[A-Za-zåäöÅÄÖ$€£:]/g, '')
    .replace(/−/g, '-')
    .replace(/[()]/g, '')
    .trim()

  if (!value) return null

  const lastComma = value.lastIndexOf(',')
  const lastDot = value.lastIndexOf('.')

  if (lastComma > -1 && lastDot > -1) {
    value = lastComma > lastDot
      ? value.replace(/\./g, '').replace(',', '.')
      : value.replace(/,/g, '')
  } else if (lastComma > -1) {
    value = value.replace(',', '.')
  } else if ((value.match(/\./g) ?? []).length > 1) {
    value = value.replace(/\./g, '')
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null
}

function parseDateValue(raw: string | null | undefined): string | null {
  if (!raw) return null
  const value = raw.trim()

  let match = value.match(/\b(20\d{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/)
  if (match) return toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]))

  match = value.match(/\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2})\b/)
  if (match) return toIsoDate(Number(match[3]), Number(match[2]), Number(match[1]))

  return null
}

function toIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function findByLabels(text: string, labels: string[], valuePattern = '([^\n]{1,120})'): string | null {
  for (const label of labels) {
    const pattern = new RegExp(`(?:^|\\n|\\b)${escapeRegex(label)}\\s*[:#-]?\\s*${valuePattern}`, 'i')
    const match = text.match(pattern)
    const value = match?.[1]?.trim()
    if (value) return value
  }
  return null
}

function findDateByLabels(text: string, labels: string[]): string | null {
  const candidates: string[] = []
  for (const label of labels) {
    const pattern = new RegExp(`(?:^|\\n|\\b)${escapeRegex(label)}\\s*[:#-]?\\s*([^\\n]{1,80})`, 'i')
    const match = text.match(pattern)
    if (match?.[1]) candidates.push(match[1])
  }
  for (const candidate of candidates) {
    const parsed = parseDateValue(candidate)
    if (parsed) return parsed
  }
  return null
}

function findAmountByLabels(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const pattern = new RegExp(`(?:^|\\n|\\b)${escapeRegex(label)}(?:\\s+inkl\\.?\\s*moms)?\\s*[:#-]?\\s*(?:SEK|kr|EUR|USD|€|\\$)?\\s*(-?[0-9][0-9\\s.,]{0,20})`, 'i')
    const match = text.match(pattern)
    const parsed = parseAmount(match?.[1])
    if (parsed != null) return parsed
  }
  return null
}

function compactDigits(input: string): string {
  return input.replace(/\D/g, '')
}

function isLuhnValid(value: string): boolean {
  const digits = compactDigits(value)
  if (digits.length !== 10) return false
  let sum = 0
  for (let i = 0; i < digits.length; i += 1) {
    let n = Number(digits[i])
    if (i % 2 === 0) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
  }
  return sum % 10 === 0
}

function formatSwedishNumber(raw: string): string | null {
  const digits = compactDigits(raw)
  if (digits.length < 2) return null
  if (digits.length <= 6) return `${digits.slice(0, -1)}-${digits.slice(-1)}`
  return `${digits.slice(0, -4)}-${digits.slice(-4)}`
}

function findOrgNumber(text: string): string | null {
  const patterns = [
    /(?:org\.?\s*nr|organisationsnummer|corporate identity number)\s*[:#-]?\s*([0-9]{6}[-\s]?[0-9]{4})/i,
    /\b([0-9]{6}[-\s][0-9]{4})\b/,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1] && isLuhnValid(match[1])) return compactDigits(match[1])
  }
  return null
}

function findVatNumber(text: string): string | null {
  const match = text.match(/\b([A-Z]{2}\s?[A-Z0-9]{8,14})\b/i)
  return match?.[1] ? match[1].replace(/\s/g, '').toUpperCase() : null
}

function findBankgiro(text: string): string | null {
  const match = text.match(/(?:bankgiro|bankgirot|bg)\s*[:#-]?\s*([0-9][0-9\s-]{4,12}[0-9])/i)
  return match?.[1] ? formatSwedishNumber(match[1]) : null
}

function findPlusgiro(text: string): string | null {
  const match = text.match(/(?:plusgiro|plusgirot|pg)\s*[:#-]?\s*([0-9][0-9\s-]{2,12}[0-9])/i)
  return match?.[1] ? formatSwedishNumber(match[1]) : null
}

function findInvoiceNumber(text: string): string | null {
  return findByLabels(text, [
    'fakturanummer',
    'faktura nr',
    'faktura no',
    'invoice number',
    'invoice no',
    'invoice #',
  ], '([A-Z0-9][A-Z0-9._/-]{1,60})')
}

function findPaymentReference(text: string): string | null {
  const value = findByLabels(text, [
    'ocr',
    'ocr-nummer',
    'betalningsreferens',
    'referens',
    'reference',
    'kid',
  ], '([0-9][0-9\s-]{4,40}[0-9])')
  if (!value) return null
  return value.replace(/[\s-]/g, '')
}

function detectCurrency(text: string): string {
  if (/\bEUR\b|€/i.test(text)) return 'EUR'
  if (/\bUSD\b|\$/i.test(text)) return 'USD'
  if (/\bNOK\b/i.test(text)) return 'NOK'
  if (/\bDKK\b/i.test(text)) return 'DKK'
  if (/\bGBP\b|£/i.test(text)) return 'GBP'
  return 'SEK'
}

function findSupplierName(text: string, fileName: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 18)

  const blocked = /^(faktura|invoice|kvitto|receipt|datum|date|kund|customer|sida|page|org\.?|moms|vat|total|att betala|ocr|bg|pg)\b/i
  const candidate = lines.find((line) => {
    if (line.length < 3 || line.length > 90) return false
    if (blocked.test(line)) return false
    if (/^[0-9\s.,:-]+$/.test(line)) return false
    return /[A-Za-zÅÄÖåäö]/.test(line)
  })

  if (candidate) return candidate.replace(/\s{2,}/g, ' ')
  const fromFile = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
  return fromFile && fromFile.length > 2 ? fromFile.slice(0, 90) : null
}

function buildVatBreakdown(subtotal: number | null, vatAmount: number | null): VatBreakdownItem[] {
  if (subtotal == null || vatAmount == null || subtotal <= 0 || vatAmount < 0) return []
  const rate = Math.round((vatAmount / subtotal) * 100)
  const supportedRate = [25, 12, 6, 0].find((candidate) => Math.abs(candidate - rate) <= 1)
  if (supportedRate == null) return []
  return [{ rate: supportedRate, base: subtotal, amount: vatAmount }]
}

function inferSubtotal(total: number | null, vatAmount: number | null): number | null {
  if (total == null || vatAmount == null) return null
  return Math.round((total - vatAmount) * 100) / 100
}

function computeConfidence(result: InvoiceExtractionResult): number {
  let score = 0
  if (result.supplier.name) score += 0.12
  if (result.supplier.orgNumber || result.supplier.vatNumber) score += 0.12
  if (result.supplier.bankgiro || result.supplier.plusgiro) score += 0.1
  if (result.invoice.invoiceNumber) score += 0.14
  if (result.invoice.invoiceDate) score += 0.12
  if (result.invoice.dueDate) score += 0.1
  if (result.invoice.paymentReference) score += 0.1
  if (result.totals.total != null) score += 0.16
  if (result.totals.vatAmount != null) score += 0.08
  if (result.vatBreakdown.length > 0) score += 0.06
  return Math.max(0, Math.min(0.98, Math.round(score * 100) / 100))
}

function extractLineItems(text: string): ExtractedInvoiceLineItem[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const items: ExtractedInvoiceLineItem[] = []
  for (const line of lines) {
    if (items.length >= 40) break
    if (!/[A-Za-zÅÄÖåäö]/.test(line)) continue
    if (/moms|vat|total|summa|att betala|faktura|invoice|ocr|bankgiro|plusgiro/i.test(line)) continue
    const amountMatch = line.match(/(-?[0-9][0-9\s.,]{1,15})\s*(?:kr|sek|eur|usd)?\s*$/i)
    const amount = parseAmount(amountMatch?.[1])
    if (amount == null || Math.abs(amount) <= 0) continue
    const description = line.replace(amountMatch?.[0] ?? '', '').trim()
    if (description.length < 3) continue
    items.push({
      description: description.slice(0, 240),
      quantity: 1,
      unitPrice: amount,
      lineTotal: amount,
      vatRate: null,
      accountSuggestion: null,
    })
  }
  return items
}

export function parseInvoiceFieldsFromOcr(input: {
  text?: string | null
  markdown?: string | null
  fileName: string
}): ParsedInvoiceFields {
  const rawText = normaliseText([input.text, input.markdown].filter(Boolean).join('\n\n'))
  if (!rawText) return { data: emptyExtractionResult(), rawText: null }

  const text = normaliseText(rawText)
  const ascii = removeDiacritics(text.toLowerCase())
  const searchable = `${text}\n${ascii}`

  const total = findAmountByLabels(searchable, [
    'att betala',
    'totalt att betala',
    'summa att betala',
    'total att betala',
    'belopp att betala',
    'amount due',
    'balance due',
    'total',
  ])
  const vatAmount = findAmountByLabels(searchable, [
    'moms',
    'varav moms',
    'vat amount',
    'vat',
  ])
  const explicitSubtotal = findAmountByLabels(searchable, [
    'belopp exkl moms',
    'summa exkl moms',
    'subtotal',
    'net amount',
  ])
  const subtotal = explicitSubtotal ?? inferSubtotal(total, vatAmount)

  const result: InvoiceExtractionResult = {
    supplier: {
      name: findSupplierName(text, input.fileName),
      orgNumber: findOrgNumber(text),
      vatNumber: findVatNumber(text),
      address: null,
      bankgiro: findBankgiro(text),
      plusgiro: findPlusgiro(text),
    },
    invoice: {
      invoiceNumber: findInvoiceNumber(searchable),
      invoiceDate: findDateByLabels(searchable, DATE_LABELS),
      dueDate: findDateByLabels(searchable, DUE_DATE_LABELS),
      paymentReference: findPaymentReference(searchable),
      currency: detectCurrency(text),
    },
    lineItems: extractLineItems(text),
    totals: { subtotal, vatAmount, total },
    vatBreakdown: buildVatBreakdown(subtotal, vatAmount),
    confidence: 0,
  }

  result.confidence = computeConfidence(result)
  return { data: result, rawText }
}
