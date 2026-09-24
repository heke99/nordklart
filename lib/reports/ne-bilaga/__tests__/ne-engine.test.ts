import { describe, it, expect } from 'vitest'
import { NE_ACCOUNT_MAPPINGS, NE_BALANCE_MAPPINGS, findNEMapping } from '../ne-engine'
import { NE_SRU_FIELD_CODES } from '../types'
import { SKV_FIELD_CODES } from '@/lib/reports/sru/skv-field-codes'
import { neIdentity } from '../sru-generator'

/**
 * Mapping per BAS kopplingstabell "NE – enskilda näringsidkare som inte
 * upprättar förenklat årsbokslut" (NE_EJ_K1-Intervall-231002). A negative net
 * is income (credit), a positive net is a cost (debit).
 */
const INCOME = -100
const COST = 100

function ruta(account: string, net: number, momsfri = false): string | null {
  return findNEMapping(account, net, momsfri)?.ruta ?? null
}

describe('NE field codes', () => {
  it('every NE row maps to an official NE field code', () => {
    for (const code of Object.values(NE_SRU_FIELD_CODES)) {
      expect(SKV_FIELD_CODES.NE.has(code), code).toBe(true)
    }
  })

  it('uses 7400–7403, 7500–7505 and 7440 for R1–R11', () => {
    expect(NE_SRU_FIELD_CODES.R1).toBe('7400')
    expect(NE_SRU_FIELD_CODES.R5).toBe('7500')
    expect(NE_SRU_FIELD_CODES.R10).toBe('7505')
    expect(NE_SRU_FIELD_CODES.R11).toBe('7440')
    expect(NE_SRU_FIELD_CODES.B10).toBe('7300')
  })
})

describe('NE revenue', () => {
  it('momspliktig sales, export and EU sales go to R1', () => {
    for (const account of ['3001', '3002', '3003', '3100', '3105', '3108', '3231', '3510', '3740', '3990']) {
      expect(ruta(account, INCOME), account).toBe('R1')
    }
  })

  it('momsfri sales and non-taxable rent go to R2', () => {
    expect(ruta('3004', INCOME)).toBe('R2')
    expect(ruta('3911', INCOME)).toBe('R2')
  })

  it('a business not registered for VAT reports all sales in R2', () => {
    expect(ruta('3001', INCOME, true)).toBe('R2')
  })

  it('38xx aktiverat arbete goes to R4', () => {
    expect(ruta('3800', INCOME)).toBe('R4')
  })
})

describe('NE costs', () => {
  it('40–49 → R5, 50–69 → R6, 70–76 → R7', () => {
    expect(ruta('4010', COST)).toBe('R5')
    expect(ruta('4990', COST)).toBe('R5')
    expect(ruta('5010', COST)).toBe('R6')
    expect(ruta('6992', COST)).toBe('R6')
    expect(ruta('7010', COST)).toBe('R7')
  })

  it('depreciation: buildings → R9, machinery/intangibles → R10', () => {
    expect(ruta('7820', COST)).toBe('R9')
    expect(ruta('7720', COST)).toBe('R9')
    expect(ruta('7830', COST)).toBe('R10')
    expect(ruta('7810', COST)).toBe('R10')
    expect(ruta('7710', COST)).toBe('R10')
  })

  it('774x/779x/79xx write-downs and other operating costs → R8', () => {
    expect(ruta('7740', COST)).toBe('R8')
    expect(ruta('7970', COST)).toBe('R8')
  })
})

describe('NE financial items by sign', () => {
  it('interest income → R4, interest cost → R8', () => {
    expect(ruta('8310', INCOME)).toBe('R4')
    expect(ruta('8410', COST)).toBe('R8')
  })

  it('802x/832x follow the sign of the balance', () => {
    expect(ruta('8020', INCOME)).toBe('R4')
    expect(ruta('8020', COST)).toBe('R8')
    expect(ruta('8320', INCOME)).toBe('R4')
    expect(ruta('8320', COST)).toBe('R8')
  })

  it('write-downs of financial assets are always R8', () => {
    expect(ruta('8070', COST)).toBe('R8')
    expect(ruta('8370', COST)).toBe('R8')
  })

  it('periodiseringsfond 881x: återföring → R4, avsättning → R8', () => {
    expect(ruta('8819', INCOME)).toBe('R4')
    expect(ruta('8811', COST)).toBe('R8')
  })
})

describe('NE balance sheet rows', () => {
  const row = (account: string) =>
    NE_BALANCE_MAPPINGS.find((m) => m.ranges.some(([a, b]) => account >= a && account <= b))?.row ?? null

  it('maps assets per the BAS table', () => {
    expect(row('1010')).toBe('B1')
    expect(row('1110')).toBe('B2')
    expect(row('1130')).toBe('B3')
    expect(row('1291')).toBe('B3')
    expect(row('1220')).toBe('B4')
    expect(row('1380')).toBe('B5')
    expect(row('1460')).toBe('B6')
    expect(row('1510')).toBe('B7')
    expect(row('1790')).toBe('B8')
    expect(row('1930')).toBe('B9')
  })

  it('maps liabilities per the BAS table', () => {
    expect(row('2110')).toBe('B11')
    expect(row('2220')).toBe('B12')
    expect(row('2350')).toBe('B13')
    expect(row('2410')).toBe('B13')
    expect(row('2440')).toBe('B15')
    expect(row('2610')).toBe('B16')
    expect(row('2710')).toBe('B16')
  })

  it('has no mapping for equity (B10 is computed)', () => {
    expect(row('2010')).toBeNull()
  })

  it('every mapping rule targets an R row', () => {
    for (const m of NE_ACCOUNT_MAPPINGS) expect(m.ruta).toMatch(/^R\d+$/)
  })
})

describe('neIdentity', () => {
  it('adds the century to a 10-digit personnummer', () => {
    const today = new Date('2026-09-24')
    expect(neIdentity('8001011234', today)).toBe('198001011234')
    expect(neIdentity('0501011234', today)).toBe('200501011234')
    expect(neIdentity('19800101-1234', today)).toBe('198001011234')
  })
})
