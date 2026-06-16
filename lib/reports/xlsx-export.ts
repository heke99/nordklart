import writeXlsxFile from 'write-excel-file/node'

/**
 * Generic xlsx workbook builder for reports.
 *
 * Uses write-excel-file instead of SheetJS/xlsx so Nordklart does not ship the
 * vulnerable xlsx package. The helper stays intentionally declarative: callers
 * provide sheet specs and get a serialized XLSX Buffer back.
 */

export type CellValue = string | number | Date | null | undefined
export type ColumnFormat = 'text' | 'currency' | 'date' | 'integer' | 'percent'

export interface ColumnSpec {
  /** Human-readable header label rendered in row 1. */
  header: string
  /** Excel number-format hint applied to every body cell in this column. */
  format: ColumnFormat
}

export interface SheetSpec<TRow> {
  /** Sheet tab name. Excel limits this to 31 characters; longer names are truncated. */
  name: string
  /** Column definitions (header + format), one per column. */
  columns: ColumnSpec[]
  /** Array of rows the sheet should render. */
  rows: TRow[]
  /**
   * Maps a single row to an array of cell values. The returned array length
   * must match `columns.length`. Use `null`/`undefined` for blank cells.
   */
  mapRow: (row: TRow) => CellValue[]
}

const CURRENCY_FORMAT = '#,##0.00 " kr"'
const DATE_FORMAT = 'yyyy-mm-dd'
const INTEGER_FORMAT = '#,##0'
const PERCENT_FORMAT = '0.00%'

function formatToExcel(format: ColumnFormat): string | undefined {
  switch (format) {
    case 'currency':
      return CURRENCY_FORMAT
    case 'date':
      return DATE_FORMAT
    case 'integer':
      return INTEGER_FORMAT
    case 'percent':
      return PERCENT_FORMAT
    default:
      return undefined
  }
}

function cellType(value: CellValue): 'String' | 'Number' | 'Date' {
  if (value instanceof Date) return 'Date'
  if (typeof value === 'number') return 'Number'
  return 'String'
}

function normalizeCellValue(value: CellValue): string | number | Date {
  if (value === null || value === undefined) return ''
  return value
}

function excelCell(value: CellValue, format: ColumnFormat) {
  const normalized = normalizeCellValue(value)
  const type = cellType(value)
  const cell: {
    value: string | number | Date
    type: 'String' | 'Number' | 'Date'
    format?: string
    fontWeight?: 'bold'
    align?: 'left' | 'right' | 'center'
  } = {
    value: normalized,
    type,
  }

  const numberFormat = formatToExcel(format)
  if (numberFormat && type !== 'String') cell.format = numberFormat
  if (format !== 'text') cell.align = 'right'
  return cell
}

function headerCell(header: string) {
  return {
    value: header,
    type: 'String' as const,
    fontWeight: 'bold' as const,
  }
}

/**
 * Build a workbook buffer from one or more sheet specs.
 *
 * @returns A Node Buffer containing the serialized xlsx file.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
export async function reportToWorkbook<_T = unknown>(spec: ReadonlyArray<SheetSpec<any>>): Promise<Buffer> {
  if (spec.length === 0) {
    throw new Error('reportToWorkbook: at least one sheet spec is required')
  }

  const sheets = spec.map((sheet) => {
    const header = sheet.columns.map((column) => headerCell(column.header))
    const body = sheet.rows.map((row) => {
      const mapped = sheet.mapRow(row)
      if (mapped.length !== sheet.columns.length) {
        throw new Error(
          `reportToWorkbook: row length ${mapped.length} does not match column count ${sheet.columns.length} on sheet "${sheet.name}"`,
        )
      }
      return mapped.map((value, index) => excelCell(value, sheet.columns[index].format))
    })

    return [header, ...body]
  })

  const out = await writeXlsxFile(sheets as never, {
    sheets: spec.map((sheet) => (sheet.name.length > 31 ? sheet.name.slice(0, 31) : sheet.name)),
    buffer: true,
  } as never)

  return Buffer.isBuffer(out)
  ? out
  : Buffer.from(out as unknown as ArrayBuffer)
}

// ─────────────────────────────────────────────────────────────────────────────
// Column helpers — small declarative builders so route files read cleanly.
// ─────────────────────────────────────────────────────────────────────────────

export function textColumn(header: string): ColumnSpec {
  return { header, format: 'text' }
}

export function currencyColumn(header: string): ColumnSpec {
  return { header, format: 'currency' }
}

export function dateColumn(header: string): ColumnSpec {
  return { header, format: 'date' }
}

export function integerColumn(header: string): ColumnSpec {
  return { header, format: 'integer' }
}

export function percentColumn(header: string): ColumnSpec {
  return { header, format: 'percent' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Filename helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Slugify a company name for use in download filenames.
 *
 * - Lowercases everything.
 * - Replaces Swedish characters (åäö) with their ASCII fallbacks.
 * - Strips anything that's not alphanumeric.
 * - Collapses runs of separators to a single dash and trims edges.
 * - Returns `'foretag'` if the input slugifies to empty (e.g. only emoji).
 */
export function slugifyCompanyName(name: string): string {
  if (!name) return 'foretag'
  const lowered = name.toLowerCase()
  const ascii = lowered
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/é/g, 'e')
    .replace(/è/g, 'e')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
  const slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'foretag'
}

/**
 * Build a filename in the form `<reportSlug>-<companySlug>-<periodYYYYMMDD>.xlsx`.
 *
 * @param reportSlug Static report identifier (e.g. `"trial-balance"`)
 * @param companyName Raw company name (will be slugified)
 * @param period ISO date string (`YYYY-MM-DD`); date separators are stripped
 */
export function xlsxFilename(reportSlug: string, companyName: string, period: string): string {
  const companySlug = slugifyCompanyName(companyName)
  const periodCompact = (period || '').replace(/-/g, '')
  const parts = [reportSlug, companySlug, periodCompact].filter(Boolean)
  return `${parts.join('-')}.xlsx`
}
