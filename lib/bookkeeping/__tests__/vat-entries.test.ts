import { describe, it, expect } from 'vitest'
import {
  getVatRate,
  generateSalesVatLines,
  generateReverseChargeLines,
  generateReverseChargeBasisLines,
  generateImportVatLines,
  generateImportBasisLines,
  generateInputVatLine,
  extractNetAmount,
  extractVatAmount,
} from '../vat-entries'

describe('getVatRate', () => {
  it('returns 0.25 for standard_25', () => {
    expect(getVatRate('standard_25')).toBe(0.25)
  })

  it('returns 0.12 for reduced_12', () => {
    expect(getVatRate('reduced_12')).toBe(0.12)
  })

  it('returns 0.06 for reduced_6', () => {
    expect(getVatRate('reduced_6')).toBe(0.06)
  })

  it('returns 0 for reverse_charge', () => {
    expect(getVatRate('reverse_charge')).toBe(0)
  })

  it('returns 0 for export', () => {
    expect(getVatRate('export')).toBe(0)
  })

  it('returns 0 for exempt', () => {
    expect(getVatRate('exempt')).toBe(0)
  })
})

describe('generateSalesVatLines', () => {
  it('credits 2611 (Utgående moms 25%) at standard rate', () => {
    const lines = generateSalesVatLines({
      vatTreatment: 'standard_25',
      baseAmount: 1000,
      direction: 'sales',
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].account_number).toBe('2611')
    expect(lines[0].debit_amount).toBe(0)
    expect(lines[0].credit_amount).toBe(250)
  })

  it('credits 2621 (Utgående moms 12%) at reduced rate', () => {
    const lines = generateSalesVatLines({
      vatTreatment: 'reduced_12',
      baseAmount: 1000,
      direction: 'sales',
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].account_number).toBe('2621')
    expect(lines[0].credit_amount).toBe(120)
  })

  it('credits 2631 (Utgående moms 6%) at reduced rate', () => {
    const lines = generateSalesVatLines({
      vatTreatment: 'reduced_6',
      baseAmount: 1000,
      direction: 'sales',
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].account_number).toBe('2631')
    expect(lines[0].credit_amount).toBe(60)
  })

  it('returns empty array for reverse_charge (no domestic VAT line)', () => {
    expect(
      generateSalesVatLines({
        vatTreatment: 'reverse_charge',
        baseAmount: 1000,
        direction: 'sales',
      })
    ).toEqual([])
  })

  it('returns empty array for export', () => {
    expect(
      generateSalesVatLines({
        vatTreatment: 'export',
        baseAmount: 1000,
        direction: 'sales',
      })
    ).toEqual([])
  })

  it('returns empty array for exempt', () => {
    expect(
      generateSalesVatLines({
        vatTreatment: 'exempt',
        baseAmount: 1000,
        direction: 'sales',
      })
    ).toEqual([])
  })

  it('rounds VAT to 2 decimals (333.33 * 0.25 = 83.3325 → 83.33)', () => {
    const lines = generateSalesVatLines({
      vatTreatment: 'standard_25',
      baseAmount: 333.33,
      direction: 'sales',
    })
    expect(lines[0].credit_amount).toBe(83.33)
  })
})

describe('generateReverseChargeLines — EU/non-EU (isDomestic=false)', () => {
  it('debits 2645 and credits 2614 at 25%', () => {
    const lines = generateReverseChargeLines(1000, 0.25, false)
    expect(lines).toHaveLength(2)
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(250)
    expect(lines[0].credit_amount).toBe(0)
    expect(lines[1].account_number).toBe('2614')
    expect(lines[1].debit_amount).toBe(0)
    expect(lines[1].credit_amount).toBe(250)
  })

  it('debits 2645 and credits 2624 at 12%', () => {
    const lines = generateReverseChargeLines(1000, 0.12, false)
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(120)
    expect(lines[1].account_number).toBe('2624')
    expect(lines[1].credit_amount).toBe(120)
  })

  it('debits 2645 and credits 2634 at 6%', () => {
    const lines = generateReverseChargeLines(1000, 0.06, false)
    expect(lines[0].account_number).toBe('2645')
    expect(lines[0].debit_amount).toBe(60)
    expect(lines[1].account_number).toBe('2634')
    expect(lines[1].credit_amount).toBe(60)
  })
})

describe('generateReverseChargeLines — domestic (isDomestic=true, ML 16 kap)', () => {
  it('debits 2647 (not 2645) and credits 2614 at 25%', () => {
    const lines = generateReverseChargeLines(1000, 0.25, true)
    expect(lines).toHaveLength(2)
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(250)
    expect(lines[1].account_number).toBe('2614')
    expect(lines[1].credit_amount).toBe(250)
  })

  it('debits 2647 and credits 2624 at 12%', () => {
    const lines = generateReverseChargeLines(1000, 0.12, true)
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(120)
    expect(lines[1].account_number).toBe('2624')
    expect(lines[1].credit_amount).toBe(120)
  })

  it('debits 2647 and credits 2634 at 6%', () => {
    const lines = generateReverseChargeLines(1000, 0.06, true)
    expect(lines[0].account_number).toBe('2647')
    expect(lines[0].debit_amount).toBe(60)
    expect(lines[1].account_number).toBe('2634')
    expect(lines[1].credit_amount).toBe(60)
  })
})

describe('generateReverseChargeLines — defaults & invariants', () => {
  it('books 2645/2614 for explicit 25% non-domestic RC', () => {
    const lines = generateReverseChargeLines(1000, 0.25)
    expect(lines[0].account_number).toBe('2645')
    expect(lines[1].account_number).toBe('2614')
    expect(lines[0].debit_amount).toBe(250)
    expect(lines[1].credit_amount).toBe(250)
  })

  it('throws on non-statutory rates instead of silently falling back to 2614', () => {
    expect(() => generateReverseChargeLines(1000, 0.18)).toThrow(/Ogiltig momssats/)
    expect(() => generateReverseChargeLines(1000, 0)).toThrow(/Ogiltig momssats/)
  })

  it('keeps debit-credit pair balanced for every rate × isDomestic combination', () => {
    for (const rate of [0.25, 0.12, 0.06]) {
      for (const isDomestic of [true, false]) {
        const lines = generateReverseChargeLines(1000, rate, isDomestic)
        expect(lines[0].debit_amount).toBe(lines[1].credit_amount)
        expect(lines[0].credit_amount).toBe(0)
        expect(lines[1].debit_amount).toBe(0)
      }
    }
  })
})

describe('generateReverseChargeBasisLines — reverse_charge_type routing', () => {
  it('routes eu_goods to 4515/4516/4517 (ruta 20)', () => {
    expect(generateReverseChargeBasisLines(1000, 0.25, 'eu_business', 'eu_goods')[0].account_number).toBe('4515')
    expect(generateReverseChargeBasisLines(1000, 0.12, 'eu_business', 'eu_goods')[0].account_number).toBe('4516')
    expect(generateReverseChargeBasisLines(1000, 0.06, 'eu_business', 'eu_goods')[0].account_number).toBe('4517')
  })

  it('routes eu_services to 4535-series (ruta 21)', () => {
    expect(generateReverseChargeBasisLines(1000, 0.25, 'eu_business', 'eu_services')[0].account_number).toBe('4535')
  })

  it('routes construction to 4425-series (ruta 24, ML 16 kap 13 §)', () => {
    expect(generateReverseChargeBasisLines(1000, 0.25, 'swedish_business', 'construction')[0].account_number).toBe('4425')
  })

  it('routes electronics to 4415-series (ruta 23, ML 16 kap 17 §)', () => {
    expect(generateReverseChargeBasisLines(1000, 0.25, 'swedish_business', 'electronics')[0].account_number).toBe('4415')
  })

  it('emits no basis lines for import (handled by the importmoms path)', () => {
    expect(generateReverseChargeBasisLines(1000, 0.25, 'non_eu_business', 'import')).toHaveLength(0)
  })

  it('explicit type overrides supplier-country inference', () => {
    // A Swedish supplier selling EU goods classification: type wins.
    expect(generateReverseChargeBasisLines(1000, 0.25, 'swedish_business', 'eu_goods')[0].account_number).toBe('4515')
  })

  it('falls back to supplier-country inference (services) without a type', () => {
    expect(generateReverseChargeBasisLines(1000, 0.25, 'eu_business')[0].account_number).toBe('4535')
    expect(generateReverseChargeBasisLines(1000, 0.25, 'non_eu_business')[0].account_number).toBe('4531')
    expect(generateReverseChargeBasisLines(1000, 0.25, 'swedish_business')[0].account_number).toBe('4425')
  })

  it('always nets to zero via 4598 motkonto', () => {
    const lines = generateReverseChargeBasisLines(1000, 0.25, 'eu_business', 'eu_goods')
    expect(lines[1].account_number).toBe('4598')
    expect(lines[0].debit_amount).toBe(lines[1].credit_amount)
  })
})

describe('generateImportVatLines / generateImportBasisLines', () => {
  it('books 2645 debit + 2615 credit for 25% import', () => {
    const lines = generateImportVatLines(10000, 0.25)
    expect(lines[0]).toMatchObject({ account_number: '2645', debit_amount: 2500 })
    expect(lines[1]).toMatchObject({ account_number: '2615', credit_amount: 2500 })
  })

  it('books 2625/2635 for reduced import rates', () => {
    expect(generateImportVatLines(10000, 0.12)[1].account_number).toBe('2625')
    expect(generateImportVatLines(10000, 0.06)[1].account_number).toBe('2635')
  })

  it('throws on non-statutory import rate', () => {
    expect(() => generateImportVatLines(10000, 0.2)).toThrow(/Ogiltig momssats/)
  })

  it('books beskattningsunderlag on 4545-4547 + 4598 motkonto (ruta 50)', () => {
    const lines = generateImportBasisLines(10000, 0.25)
    expect(lines[0]).toMatchObject({ account_number: '4545', debit_amount: 10000 })
    expect(lines[1]).toMatchObject({ account_number: '4598', credit_amount: 10000 })
    expect(generateImportBasisLines(10000, 0.12)[0].account_number).toBe('4546')
    expect(generateImportBasisLines(10000, 0.06)[0].account_number).toBe('4547')
  })

  it('SKV cross-validation invariant: ruta 60 ≈ ruta 50 × rate', () => {
    const vat = generateImportVatLines(12345.67, 0.25)
    const basis = generateImportBasisLines(12345.67, 0.25)
    expect(vat[1].credit_amount).toBeCloseTo(basis[0].debit_amount * 0.25, 2)
  })
})

describe('generateInputVatLine', () => {
  it('debits 2641 with VAT extracted from gross at 25% (1250 → 250)', () => {
    const line = generateInputVatLine(1250, 0.25)
    expect(line).not.toBeNull()
    expect(line!.account_number).toBe('2641')
    expect(line!.debit_amount).toBe(250)
    expect(line!.credit_amount).toBe(0)
  })

  it('debits 2641 at 12% (1120 → 120)', () => {
    const line = generateInputVatLine(1120, 0.12)
    expect(line!.account_number).toBe('2641')
    expect(line!.debit_amount).toBe(120)
  })

  it('debits 2641 at 6% (1060 → 60)', () => {
    const line = generateInputVatLine(1060, 0.06)
    expect(line!.account_number).toBe('2641')
    expect(line!.debit_amount).toBe(60)
  })

  it('returns null at zero rate (export/exempt/reverse_charge purchases)', () => {
    expect(generateInputVatLine(1000, 0)).toBeNull()
  })

  it('defaults to vatRate=0.25 when omitted', () => {
    const line = generateInputVatLine(1250)
    expect(line!.debit_amount).toBe(250)
  })
})

describe('extractNetAmount', () => {
  it('extracts 1000 net from 1250 gross at 25%', () => {
    expect(extractNetAmount(1250, 0.25)).toBe(1000)
  })

  it('extracts 1000 net from 1120 gross at 12%', () => {
    expect(extractNetAmount(1120, 0.12)).toBe(1000)
  })

  it('extracts 1000 net from 1060 gross at 6%', () => {
    expect(extractNetAmount(1060, 0.06)).toBe(1000)
  })

  it('returns total unchanged at zero rate', () => {
    expect(extractNetAmount(1000, 0)).toBe(1000)
  })
})

describe('extractVatAmount', () => {
  it('extracts 250 VAT from 1250 gross at 25%', () => {
    expect(extractVatAmount(1250, 0.25)).toBe(250)
  })

  it('extracts 120 VAT from 1120 gross at 12%', () => {
    expect(extractVatAmount(1120, 0.12)).toBe(120)
  })

  it('extracts 60 VAT from 1060 gross at 6%', () => {
    expect(extractVatAmount(1060, 0.06)).toBe(60)
  })

  it('returns 0 at zero rate', () => {
    expect(extractVatAmount(1000, 0)).toBe(0)
  })
})

describe('extractNetAmount + extractVatAmount round-trip', () => {
  it.each([
    [1250, 0.25],
    [1120, 0.12],
    [1060, 0.06],
  ])('reconstructs total %s from net + vat at rate %s', (total, rate) => {
    const net = extractNetAmount(total, rate)
    const vat = extractVatAmount(total, rate)
    expect(net + vat).toBe(total)
  })
})
