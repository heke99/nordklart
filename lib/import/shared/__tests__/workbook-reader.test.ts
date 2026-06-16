import { describe, it, expect } from 'vitest'
import { createXlsxBuffer } from '@/lib/test/create-xlsx-buffer'
import { readBestSheet } from '../workbook-reader'

function bufFromBytes(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

describe('readBestSheet', () => {
  it('decodes UTF-8 CSV with Swedish characters correctly', async () => {
    const csv = new TextEncoder().encode('Namn,Ort\nAcme,GÖTEBORG\nBeta,KÄRRA\n').buffer
    const result = await readBestSheet(csv, 'lev.csv')
    expect(result.rawData).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
      ['Beta', 'KÄRRA'],
    ])
  })

  it('decodes UTF-8 CSV with BOM', async () => {
    const bom = [0xef, 0xbb, 0xbf]
    const body = Array.from(new TextEncoder().encode('Namn,Ort\nAcme,GÖTEBORG\n'))
    const result = await readBestSheet(bufFromBytes([...bom, ...body]), 'lev.csv')
    expect(result.rawData).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
    ])
  })

  it('decodes Windows-1252 CSV with Swedish characters', async () => {
    const bytes = [
      0x4e, 0x61, 0x6d, 0x6e, 0x2c, 0x4f, 0x72, 0x74, 0x0a,
      0x41, 0x63, 0x6d, 0x65, 0x2c, 0x47, 0xd6, 0x54, 0x45, 0x42, 0x4f, 0x52, 0x47, 0x0a,
      0x42, 0x65, 0x74, 0x61, 0x2c, 0x4b, 0xc4, 0x52, 0x52, 0x41, 0x0a,
    ]
    const result = await readBestSheet(bufFromBytes(bytes), 'lev.csv')
    expect(result.rawData).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
      ['Beta', 'KÄRRA'],
    ])
  })

  it('reads xlsx files without the vulnerable xlsx package', async () => {
    const buffer = await createXlsxBuffer([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
    ])

    const result = await readBestSheet(buffer, 'data.xlsx')
    expect(result.rawData).toEqual([
      ['Namn', 'Ort'],
      ['Acme', 'GÖTEBORG'],
    ])
  })

  it('rejects unsupported spreadsheet formats explicitly', async () => {
    const buffer = await createXlsxBuffer([['A'], ['Ö']])
    await expect(readBestSheet(buffer, 'data.xls')).rejects.toThrow(/stöds inte/)
  })
})
