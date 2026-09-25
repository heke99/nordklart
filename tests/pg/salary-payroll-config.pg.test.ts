import { describe, expect, it } from 'vitest'
import { getPool } from './setup'

describe('salary_payroll_config seed', () => {
  it('has 2025 and 2026 with the official prisbasbelopp', async () => {
    const { rows } = await getPool().query<{ config_year: number; prisbasbelopp: string; avgifter_youth_rate: string | null }>(
      `SELECT config_year, prisbasbelopp, avgifter_youth_rate FROM public.salary_payroll_config
        WHERE config_year IN (2025, 2026) ORDER BY config_year`,
    )
    expect(rows.map((r) => [r.config_year, Number(r.prisbasbelopp)])).toEqual([[2025, 58800], [2026, 59200]])
    expect(rows[0].avgifter_youth_rate).toBeNull()
  })

  it('applies the reduced avgift from 66 at the start of 2025 and 67 from 2026 (born 1938–1958 both years)', async () => {
    const { rows } = await getPool().query<{ config_year: number; reduced_avgift_age: number }>(
      `SELECT config_year, reduced_avgift_age FROM public.salary_payroll_config
        WHERE config_year IN (2025, 2026) ORDER BY config_year`,
    )
    expect(rows.map((r) => [r.config_year, r.reduced_avgift_age])).toEqual([[2025, 66], [2026, 67]])
  })
})
