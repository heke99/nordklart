import readXlsxFile from 'read-excel-file/node'
import { decodeFileContent } from './encoding'

export interface WorkbookReadResult {
  sheetName: string
  rawData: string[][]
}

function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).trim()
}

function parseCsvRows(buffer: ArrayBuffer): string[][] {
  const content = decodeFileContent(buffer)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    const next = content[i + 1]

    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"'
        i++
      } else {
        quoted = !quoted
      }
      continue
    }

    if (!quoted && (char === ',' || char === ';' || char === '\t')) {
      row.push(cell.trim())
      cell = ''
      continue
    }

    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i++
      row.push(cell.trim())
      if (row.some((value) => value !== '')) rows.push(row)
      row = []
      cell = ''
      continue
    }

    cell += char
  }

  row.push(cell.trim())
  if (row.some((value) => value !== '')) rows.push(row)
  return rows
}

function normalizeRows(rows: unknown[][]): string[][] {
  return rows.map((row) => row.map(normalizeCell))
}

/**
 * Read the uploaded register/import file and return normalized rows from the
 * first worksheet. CSV is decoded through our Swedish-aware text decoder;
 * XLSX is parsed with read-excel-file to avoid the vulnerable SheetJS package.
 */
export async function readBestSheet(
  buffer: ArrayBuffer,
  filename: string,
): Promise<WorkbookReadResult> {
  const ext = filename.toLowerCase().split('.').pop() ?? ''

  if (ext === 'csv') {
    return { sheetName: 'CSV', rawData: parseCsvRows(buffer) }
  }

  if (ext !== 'xlsx') {
    throw new Error('Filformatet stöds inte. Ladda upp en XLSX- eller CSV-fil.')
  }

  const rows = await readXlsxFile(Buffer.from(buffer))
  return { sheetName: 'Sheet1', rawData: normalizeRows(rows) }
}
