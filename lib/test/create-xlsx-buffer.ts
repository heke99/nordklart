import writeXlsxFile from 'write-excel-file/node'

export async function createXlsxBuffer(
  rows: unknown[][],
  sheetName = 'Sheet1',
): Promise<ArrayBuffer> {
  const buffer = await writeXlsxFile(
    rows.map((row) =>
      row.map((value) => ({
        value: value == null ? '' : String(value),
      })),
    ),
    {
      sheet: sheetName,
      buffer: true,
    } as never,
  )

  return buffer as unknown as ArrayBuffer
}