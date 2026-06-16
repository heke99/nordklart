import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Locks in the labels seed_chart_of_accounts() writes for the 26xx output VAT
 * accounts. Per BAS 2026: 2611=25%, 2621=12%, 2631=6%.
 *
 * Background: this mapping has regressed once already (2026-03-30 multi-tenant
 * refactor copy-pasted the original 2024 buggy seed back in). The engine and
 * the VAT-rutor mapping both route by account number, so a mislabel in this
 * function never breaks any other test — only the chart-of-accounts UI shows
 * the wrong text. This test is the canary.
 */

describe('seed_chart_of_accounts', () => {
  it('seeds 26xx VAT accounts with BAS-correct labels', async () => {
    const { companyId } = await seedCompany()
    const pool = getPool()

    await pool.query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [
      companyId,
      'aktiebolag',
    ])

    const { rows } = await pool.query<{ account_number: string; account_name: string }>(
      `SELECT account_number, account_name
         FROM public.chart_of_accounts
        WHERE company_id = $1
          AND account_number IN ('2611', '2621', '2631')
        ORDER BY account_number`,
      [companyId],
    )

    const byNumber = Object.fromEntries(rows.map((r) => [r.account_number, r.account_name]))

    expect(byNumber['2611']).toBeDefined()
    expect(byNumber['2611']).toMatch(/25\s*%/)
    expect(byNumber['2611']).toMatch(/[Uu]tg.*moms/)

    expect(byNumber['2621']).toBeDefined()
    expect(byNumber['2621']).toMatch(/12\s*%/)

    expect(byNumber['2631']).toBeDefined()
    expect(byNumber['2631']).toMatch(/6\s*%/)
  })

  it('seeds the input VAT account 2641', async () => {
    const { companyId } = await seedCompany()
    const pool = getPool()

    await pool.query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [
      companyId,
      'aktiebolag',
    ])

    const { rows } = await pool.query<{ account_name: string }>(
      `SELECT account_name FROM public.chart_of_accounts
        WHERE company_id = $1 AND account_number = '2641'`,
      [companyId],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].account_name).toMatch(/[Ii]ng.*moms/)
  })
})
