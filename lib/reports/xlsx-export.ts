import JSZip from 'jszip'

/**
 * Isolated XLSX workbook builder for Nordklart report/register exports.
 *
 * This deliberately avoids the legacy `xlsx` package. The exporter writes the
 * small subset of Office Open XML that Nordklart needs: one or more worksheets,
 * typed text/number/date cells, frozen header rows and sensible column widths.
 * It keeps accounting/report rules outside the export layer and returns a Node
 * Buffer suitable for NextResponse downloads.
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
  // Method (not property) syntax on purpose: method parameters are checked
  // bivariantly, which lets a SheetSpec<ConcreteRow> flow into the
  // heterogeneous WorkbookSheetSpec (= SheetSpec<unknown>) below.
  mapRow(row: TRow): CellValue[]
}

// Heterogeneous workbooks (sheets with different row types) fit here thanks to
// the bivariant `mapRow` method check; annotate the `mapRow` parameter type
// explicitly at such call sites.
export type WorkbookSheetSpec = SheetSpec<unknown>

export const UTF8_BOM = '\uFEFF'

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function sheetName(name: string, used: Set<string>): string {
  const base = (name || 'Blad').replace(/[\\/?*:[\]]/g, ' ').trim().slice(0, 31) || 'Blad'
  let candidate = base
  let n = 2
  while (used.has(candidate)) {
    const suffix = ` ${n++}`
    candidate = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`
  }
  used.add(candidate)
  return candidate
}

function columnName(index: number): string {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const r = (n - 1) % 26
    name = String.fromCharCode(65 + r) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

function displayLength(value: CellValue, format: ColumnFormat): number {
  if (value === null || value === undefined) return 0
  if (value instanceof Date) return 10
  if (typeof value === 'number') {
    if (format === 'currency') return Math.abs(value).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ').length + 3 + (value < 0 ? 1 : 0)
    if (format === 'integer') return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ').length + (value < 0 ? 1 : 0)
    if (format === 'percent') return (value * 100).toFixed(2).length + 1
    return value.toString().length
  }
  return String(value).length
}

function normalizeCell(value: CellValue, format: ColumnFormat): CellValue {
  if (value === undefined) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && format === 'integer') return Math.round(value)
  return value
}

function cellXml(value: CellValue, rowIndex: number, colIndex: number): string {
  if (value === null || value === undefined || value === '') return ''
  const ref = `${columnName(colIndex)}${rowIndex + 1}`
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(String(value))}</t></is></c>`
}

function worksheetXml<TRow>(sheet: SheetSpec<TRow>): string {
  if (sheet.columns.length === 0) {
    throw new Error(`reportToWorkbook: sheet "${sheet.name}" must have at least one column`)
  }

  const header = sheet.columns.map((c) => c.header)
  const body = sheet.rows.map((row) => {
    const mapped = sheet.mapRow(row)
    if (mapped.length !== sheet.columns.length) {
      throw new Error(
        `reportToWorkbook: row length ${mapped.length} does not match column count ${sheet.columns.length} on sheet "${sheet.name}"`,
      )
    }
    return mapped.map((value, index) => normalizeCell(value, sheet.columns[index].format))
  })
  const rows = [header, ...body]
  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row.map((value, colIndex) => cellXml(value, rowIndex, colIndex)).join('')
      return `<row r="${rowIndex + 1}">${cells}</row>`
    })
    .join('')

  const colXml = sheet.columns
    .map((col, colIndex) => {
      let max = col.header.length
      for (const row of body) {
        const len = displayLength(row[colIndex], col.format)
        if (len > max) max = len
      }
      const width = Math.min(Math.max(max + 2, 8), 60)
      const n = colIndex + 1
      return `<col min="${n}" max="${n}" width="${width}" customWidth="1"/>`
    })
    .join('')

  const dimension = `A1:${columnName(sheet.columns.length - 1)}${Math.max(1, rows.length)}`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="${dimension}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${colXml}</cols>
  <sheetData>${rowXml}</sheetData>
</worksheet>`
}

function workbookXml(names: string[]): string {
  const sheets = names
    .map((name, index) => `<sheet name="${xmlEscape(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`
}

function workbookRels(names: string[]): string {
  const rels = names
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`
}

function contentTypes(names: string[]): string {
  const sheets = names
    .map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${sheets}
</Types>`
}

function csvEscape(value: CellValue): string {
  const normalized = value instanceof Date ? value.toISOString().slice(0, 10) : value
  if (normalized === null || normalized === undefined) return ''
  const s = String(normalized)
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv<TRow>(sheet: SheetSpec<TRow>): Buffer {
  const rows = [
    sheet.columns.map((c) => c.header),
    ...sheet.rows.map((row) => {
      const mapped = sheet.mapRow(row)
      if (mapped.length !== sheet.columns.length) {
        throw new Error(
          `reportToWorkbook: row length ${mapped.length} does not match column count ${sheet.columns.length} on sheet "${sheet.name}"`,
        )
      }
      return mapped
    }),
  ]
  return Buffer.from(rows.map((row) => row.map(csvEscape).join(';')).join('\n'), 'utf-8')
}

export async function reportToWorkbook<TRow>(spec: ReadonlyArray<SheetSpec<TRow>>, options?: { bookType?: 'xlsx' | 'csv' }): Promise<Buffer>
export async function reportToWorkbook(spec: ReadonlyArray<WorkbookSheetSpec>, options?: { bookType?: 'xlsx' | 'csv' }): Promise<Buffer>
export async function reportToWorkbook(spec: ReadonlyArray<WorkbookSheetSpec>, options: { bookType?: 'xlsx' | 'csv' } = {}): Promise<Buffer> {
  if (spec.length === 0) throw new Error('reportToWorkbook: at least one sheet spec is required')
  if (options.bookType === 'csv') return toCsv(spec[0])

  const zip = new JSZip()
  const usedNames = new Set<string>()
  const names = spec.map((sheet) => sheetName(sheet.name, usedNames))

  zip.file('[Content_Types].xml', contentTypes(names))
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`)
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Nordklart</dc:creator><cp:lastModifiedBy>Nordklart</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`)
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Nordklart</Application></Properties>`)
  zip.file('xl/workbook.xml', workbookXml(names))
  zip.file('xl/_rels/workbook.xml.rels', workbookRels(names))
  spec.forEach((sheet, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet)))

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
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
  return [reportSlug, companySlug, periodCompact].filter(Boolean).join('-') + '.xlsx'
}

export function exportFilename(slug: string, companyName: string, date: string, ext: 'xlsx' | 'csv'): string {
  const companySlug = slugifyCompanyName(companyName)
  const dateCompact = (date || '').replace(/-/g, '')
  return [slug, companySlug, dateCompact].filter(Boolean).join('-') + `.${ext}`
}
