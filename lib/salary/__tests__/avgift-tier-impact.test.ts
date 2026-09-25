import { describe, expect, it, vi } from 'vitest'

// Plaintext personnummer in, plaintext out: only the age tier is under test.
vi.mock('../personnummer', async () => {
  const actual = (await vi.importActual('../personnummer')) as Record<string, unknown>
  return { ...actual, decryptPersonnummer: (value: string) => value }
})

import { assessAvgiftTierImpact, avgiftAmount } from '../avgift-tier-impact'
import type { PayrollConfig } from '../payroll-config'

const base = {
  avgifterTotal: 0.3142,
  avgifterReduced65plus: 0.1021,
  avgifterYouthSalaryCap: 25000,
  avgifterVaxaStodCap: 35000,
  avgifterVaxaStodRate: 0.1021,
} as PayrollConfig
const config2025 = { ...base, configYear: 2025, avgifterYouthRate: null, reducedAvgiftAge: 66 } as PayrollConfig
const config2026 = { ...base, configYear: 2026, avgifterYouthRate: 0.2081, reducedAvgiftAge: 67 } as PayrollConfig

const row = (pnr: string, paymentDate: string, storedCategory: string, storedRate: number, basis = 40000) => ({
  paymentDate,
  encryptedPersonnummer: pnr,
  vaxaStodEligible: false,
  vaxaStodStart: null,
  vaxaStodEnd: null,
  storedCategory,
  storedRate,
  storedAmount: avgiftAmount(storedCategory, storedRate, basis, storedRate === 0.2081 ? config2026 : config2025),
  basis,
  hasOverride: false,
})

describe('assessAvgiftTierImpact', () => {
  it('finds a 1958-born employee charged the full rate on 2025 pay', () => {
    const impact = assessAvgiftTierImpact(row('195806151234', '2025-05-25', 'standard', 0.3142), config2025)
    expect(impact).toMatchObject({ correctCategory: 'reduced_65plus', storedAmount: 12568, correctAmount: 4084 })
    expect(impact!.difference).toBe(-8484)
  })

  it('finds a 1 January 2003 birth denied the 2026 youth rate', () => {
    const impact = assessAvgiftTierImpact(row('200301011234', '2026-05-25', 'standard', 0.3142), config2026)
    expect(impact?.correctCategory).toBe('youth')
    // 25 000 × 20,81 % + 15 000 × 31,42 %
    expect(impact?.correctAmount).toBe(9915.5)
  })

  it('ignores rows that are already right, overridden or without basis', () => {
    expect(assessAvgiftTierImpact(row('199006151234', '2026-05-25', 'standard', 0.3142), config2026)).toBeNull()
    expect(assessAvgiftTierImpact({ ...row('195806151234', '2025-05-25', 'standard', 0.3142), hasOverride: true }, config2025)).toBeNull()
    expect(assessAvgiftTierImpact({ ...row('195806151234', '2025-05-25', 'standard', 0.3142), basis: 0 }, config2025)).toBeNull()
  })
})
