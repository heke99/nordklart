import { reportToWorkbook, textColumn } from '@/lib/reports/xlsx-export'

/** Test helper that writes an in-memory XLSX workbook without the legacy xlsx package. */
export async function createXlsxBuffer(rows: unknown[][], sheetName = 'Sheet1'): Promise<ArrayBuffer> {
  if (rows.length === 0) {
    const emptyBuffer = await reportToWorkbook([{ name: sheetName, columns: [textColumn('Tom')], rows: [], mapRow: () => [''] }])
    return toArrayBuffer(emptyBuffer)
  }
  const [headers, ...body] = rows
  const columns = headers.map((header, index) => textColumn(String(header ?? `Kolumn ${index + 1}`)))
  const buffer = await reportToWorkbook([
    {
      name: sheetName,
      columns,
      rows: body,
      mapRow: (row) => row as (string | number | Date | null | undefined)[],
    },
  ])
  return toArrayBuffer(buffer)
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength)
  new Uint8Array(out).set(buffer)
  return out
}
