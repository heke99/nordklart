import { describe, it, expect } from 'vitest'
import { createXlsxBuffer } from '@/lib/test/create-xlsx-buffer'
import { parseSuppliersFile } from '../parser'

async function buildXlsx(rows: (string | number)[][]): Promise<ArrayBuffer> {
  return createXlsxBuffer(rows, 'Leverantörer')
}

describe('parseSuppliersFile', () => {
  it('parses Swedish supplier register with bankgiro/iban', async () => {
    const buffer = await buildXlsx([
      ['Namn', 'Orgnr', 'Bankgiro', 'Plusgiro', 'IBAN', 'BIC'],
      ['Acme AB', '5560217780', '123-4567', '12 34 56-7', 'SE3550000000054910000003', 'ESSESESS'],
    ])

    const result = await parseSuppliersFile(buffer, 'lev.xlsx')

    expect(result.rows[0].name).toBe('Acme AB')
    expect(result.rows[0].bankgiro).toBe('123-4567')
    expect(result.rows[0].plusgiro).toBe('123456-7')
    expect(result.rows[0].iban).toBe('SE3550000000054910000003')
    expect(result.rows[0].bic).toBe('ESSESESS')
    expect(result.rows[0].is_valid).toBe(true)
  })

  it('classifies eu_business by VAT prefix', async () => {
    const buffer = await buildXlsx([
      ['Namn', 'VAT'],
      ['Müller GmbH', 'DE123456789'],
    ])
    const result = await parseSuppliersFile(buffer, 'eu.xlsx')
    expect(result.rows[0].supplier_type).toBe('eu_business')
  })

  it('flags invalid IBAN format', async () => {
    const buffer = await buildXlsx([
      ['Namn', 'IBAN'],
      ['Acme AB', 'NOT-AN-IBAN'],
    ])
    const result = await parseSuppliersFile(buffer, 'bad-iban.xlsx')
    expect(result.rows[0].is_valid).toBe(false)
    expect(result.rows[0].validation_errors).toContain('Ogiltigt IBAN')
  })

  it('defaults currency to SEK when missing or invalid', async () => {
    const buffer = await buildXlsx([
      ['Namn', 'Valuta'],
      ['Acme AB', ''],
      ['Beta AB', 'XYZ'],
      ['Gamma AB', 'EUR'],
    ])
    const result = await parseSuppliersFile(buffer, 'curr.xlsx')
    expect(result.rows[0].default_currency).toBe('SEK')
    expect(result.rows[1].default_currency).toBe('SEK')
    expect(result.rows[2].default_currency).toBe('EUR')
  })

  it('skips rows with empty name', async () => {
    const buffer = await buildXlsx([
      ['Namn'],
      ['Acme AB'],
      [''],
      ['Beta AB'],
    ])
    const result = await parseSuppliersFile(buffer, 'sparse.xlsx')
    expect(result.total_rows).toBe(2)
  })

  it('cleans bankgiro number formatting', async () => {
    const buffer = await buildXlsx([
      ['Namn', 'Bankgiro'],
      ['Acme AB', '5402 9685'],
    ])
    const result = await parseSuppliersFile(buffer, 'bg.xlsx')
    expect(result.rows[0].bankgiro).toBe('54029685')
  })

  it('preserves Swedish characters when reading a UTF-8 CSV', async () => {
    const csv = new TextEncoder().encode(
      'Namn,Ort\nDinel AB,GÖTEBORG\nHisings AB,HISINGS KÄRRA\n',
    ).buffer
    const result = await parseSuppliersFile(csv, 'lev.csv')
    expect(result.rows[0].city).toBe('GÖTEBORG')
    expect(result.rows[1].city).toBe('HISINGS KÄRRA')
  })

  it('preserves Swedish characters when reading a Windows-1252 CSV', async () => {
    // Ö = 0xD6, Ä = 0xC4 in Windows-1252
    const bytes = [
      0x4e, 0x61, 0x6d, 0x6e, 0x2c, 0x4f, 0x72, 0x74, 0x0a, // "Namn,Ort\n"
      0x41, 0x63, 0x6d, 0x65, 0x2c, 0x47, 0xd6, 0x54, 0x45, 0x42, 0x4f, 0x52, 0x47, 0x0a, // "Acme,GÖTEBORG\n"
      0x42, 0x65, 0x74, 0x61, 0x2c, 0x4b, 0xc4, 0x52, 0x52, 0x41, 0x0a, // "Beta,KÄRRA\n"
    ]
    const result = await parseSuppliersFile(new Uint8Array(bytes).buffer, 'lev.csv')
    expect(result.rows[0].city).toBe('GÖTEBORG')
    expect(result.rows[1].city).toBe('KÄRRA')
  })
})
