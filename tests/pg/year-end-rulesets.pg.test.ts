import { describe, expect, it } from 'vitest'
import { getPool } from './setup'

/**
 * year_end_rulesets carries the statutory rates the year-end and INK2 engines
 * read. The values are pinned here against their public source so a later
 * migration cannot drift them silently.
 *
 *   - bolagsskatt 20,6 % (IL 65 kap. 10 §)
 *   - periodiseringsfond AB 25 % (IL 30 kap. 5 §)
 *   - schablonintäkt = statslåneräntan 30 nov året före (IL 30 kap. 6 a §):
 *     1,96 % for 2025, 2,55 % for 2026 (Skatteverket)
 */
describe('year_end_rulesets', () => {
  it.each([
    [2025, 0.0196],
    [2026, 0.0255],
  ])('tax year %i has the statutory rates', async (year, schablon) => {
    const { rows } = await getPool().query(
      `SELECT corporate_tax_rate, periodiseringsfond_rate, schablonintakt_rate
         FROM public.year_end_rulesets WHERE tax_year = $1`,
      [year],
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].corporate_tax_rate)).toBe(0.206)
    expect(Number(rows[0].periodiseringsfond_rate)).toBe(0.25)
    expect(Number(rows[0].schablonintakt_rate)).toBe(schablon)
  })
})
