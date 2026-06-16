import { describe, it, expect } from 'vitest'
import readXlsxFile from 'read-excel-file/node'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  dateColumn,
  integerColumn,
  percentColumn,
  slugifyCompanyName,
  xlsxFilename,
  type SheetSpec,
} from '../xlsx-export'

async function rowsOf(buffer: Buffer): Promise<unknown[][]> {
  return readXlsxFile(buffer)
}

describe('reportToWorkbook', () => {
  it('writes a single sheet with header row and body cells', async () => {
    type Row = { account: string; amount: number }
    const spec: SheetSpec<Row> = {
      name: 'Test',
      columns: [textColumn('Konto'), currencyColumn('Belopp')],
      rows: [
        { account: '1930', amount: 1500.5 },
        { account: '2440', amount: -750.25 },
      ],
      mapRow: (r) => [r.account, r.amount],
    }

    const buffer = await reportToWorkbook([spec])
    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer.byteLength).toBeGreaterThan(0)

    const rows = await rowsOf(buffer)
    expect(rows).toEqual([
      ['Konto', 'Belopp'],
      ['1930', 1500.5],
      ['2440', -750.25],
    ])
  })

  it('writes supported number/date column types', async () => {
    const buffer = await reportToWorkbook([
      {
        name: 'Numeric',
        columns: [dateColumn('Datum'), integerColumn('Antal'), percentColumn('Andel')],
        rows: [{ date: new Date('2026-01-15T00:00:00Z'), count: 42, share: 0.255 }],
        mapRow: (r) => [r.date, r.count, r.share],
      },
    ])

    const rows = await rowsOf(buffer)
    expect(rows[0]).toEqual(['Datum', 'Antal', 'Andel'])
    expect(rows[1][1]).toBe(42)
    expect(rows[1][2]).toBe(0.255)
  })

  it('produces a workbook with multiple sheets', async () => {
    const buffer = await reportToWorkbook([
      {
        name: 'Saldo',
        columns: [textColumn('Konto'), currencyColumn('Belopp')],
        rows: [{ account: '1930', amount: 100 }],
        mapRow: (r) => [r.account, r.amount],
      },
      {
        name: 'Period',
        columns: [dateColumn('Datum'), integerColumn('Antal')],
        rows: [{ date: new Date('2026-01-15'), count: 5 }],
        mapRow: (r) => [r.date, r.count],
      },
    ])

    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer.byteLength).toBeGreaterThan(0)
  })

  it('handles empty row arrays', async () => {
    const buffer = await reportToWorkbook([
      {
        name: 'Empty',
        columns: [textColumn('Konto'), currencyColumn('Belopp')],
        rows: [],
        mapRow: () => ['unused', 0],
      },
    ])

    const rows = await rowsOf(buffer)
    expect(rows).toEqual([['Konto', 'Belopp']])
  })

  it('treats undefined cells as blank', async () => {
    const buffer = await reportToWorkbook([
      {
        name: 'Sparse',
        columns: [textColumn('A'), textColumn('B')],
        rows: [{ a: 'x', b: undefined }],
        mapRow: (r) => [r.a, r.b ?? null],
      },
    ])

    const rows = await rowsOf(buffer)
    expect(rows[1][0]).toBe('x')
    expect(rows[1][1]).toBeNull()
  })

  it('throws when row length does not match column count', async () => {
    await expect(
      reportToWorkbook([
        {
          name: 'Bad',
          columns: [textColumn('A'), textColumn('B')],
          rows: [{ x: 1 }],
          mapRow: () => ['only one'],
        },
      ]),
    ).rejects.toThrow(/row length 1 does not match column count 2/)
  })

  it('throws when given zero sheets', async () => {
    await expect(reportToWorkbook([])).rejects.toThrow(/at least one sheet/)
  })
})

describe('slugifyCompanyName', () => {
  it('lowercases and dasherizes', () => {
    expect(slugifyCompanyName('Acme Bookkeeping AB')).toBe('acme-bookkeeping-ab')
  })

  it('replaces Swedish characters', () => {
    expect(slugifyCompanyName('Räksmörgås & Co')).toBe('raksmorgas-co')
  })

  it('falls back to "foretag" when empty', () => {
    expect(slugifyCompanyName('')).toBe('foretag')
    expect(slugifyCompanyName('!!!')).toBe('foretag')
  })

  it('collapses repeated separators', () => {
    expect(slugifyCompanyName('Foo   Bar___Baz')).toBe('foo-bar-baz')
  })
})

describe('xlsxFilename', () => {
  it('combines slug, company, and compact period', () => {
    expect(xlsxFilename('trial-balance', 'Räksmörgås AB', '2026-03-31')).toBe(
      'trial-balance-raksmorgas-ab-20260331.xlsx',
    )
  })
})
