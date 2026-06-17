/** XLSX test helper intentionally disabled in Nordklart baseline. */
export async function createXlsxBuffer(_rows: unknown[][], _sheetName = 'Sheet1'): Promise<ArrayBuffer> {
  throw new Error('XLSX_EXPORT_DISABLED')
}
