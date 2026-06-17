/**
 * XLSX exports are intentionally disabled in this Nordklart build.
 *
 * The project currently standardises on SIE, PDF/HTML, CSV and JSON/API output
 * for reports. Keeping this helper dependency-free prevents the Next.js build
 * from pulling xlsx/writeBuffer style APIs back into the server bundle. When
 * XLSX returns, it should be implemented as an isolated server-only export
 * module with its own tests and without touching the accounting/report rules.
 */

export type CellValue = string | number | Date | null | undefined
export type ColumnFormat = 'text' | 'currency' | 'date' | 'integer' | 'percent'

export interface ColumnSpec {
  header: string
  format: ColumnFormat
}

export interface SheetSpec<TRow> {
  name: string
  columns: ColumnSpec[]
  rows: TRow[]
  mapRow: (row: TRow) => CellValue[]
}

export function xlsxExportsDisabledResponse(): Response {
  return Response.json(
    {
      error: 'XLSX_EXPORT_DISABLED',
      message: 'Excel-export är avstängd i denna Nordklart-build. Använd PDF, CSV, SIE eller API-export.',
    },
    { status: 410 },
  )
}

export async function reportToWorkbook<_T = unknown>(_spec: ReadonlyArray<SheetSpec<unknown>>): Promise<Buffer> {
  throw new Error('XLSX_EXPORT_DISABLED')
}

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

export function slugifyCompanyName(name: string): string {
  if (!name) return 'foretag'
  const slug = name
    .toLowerCase()
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/é/g, 'e')
    .replace(/è/g, 'e')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'foretag'
}

export function xlsxFilename(reportSlug: string, companyName: string, period: string): string {
  const companySlug = slugifyCompanyName(companyName)
  const periodCompact = (period || '').replace(/-/g, '')
  return [reportSlug, companySlug, periodCompact].filter(Boolean).join('-') + '.disabled'
}
