/**
 * pg-real test for 20260924104000_bas_sru_codes_from_declaration_mapping.sql.
 *
 * The SQL ranges are generated from lib/reports/sru/account-sru.ts. This
 * compares every BAS account 1000–8999 for both entity types, so the database
 * and the declaration engines cannot silently disagree about where an account
 * reports. Also covers the chart_of_accounts trigger.
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany } from './fixtures'
import { sruCodeForAccount } from '@/lib/reports/sru/account-sru'

describe('bas_sru_code', () => {
  it.each(['aktiebolag', 'enskild_firma'] as const)('matches the TypeScript mapping for every account (%s)', async (entity) => {
    const { rows } = await getPool().query<{ account: string; code: string | null }>(
      `SELECT a::text AS account, public.bas_sru_code(a::text, $1) AS code
         FROM generate_series(1000, 8999) AS a`,
      [entity],
    )
    const mismatches = rows
      .filter((r) => (sruCodeForAccount(r.account, entity) ?? null) !== r.code)
      .map((r) => `${r.account}: sql=${r.code} ts=${sruCodeForAccount(r.account, entity)}`)
    expect(mismatches).toEqual([])
  })
})

describe('chart_of_accounts SRU trigger', () => {
  async function companyOf(entity: 'aktiebolag' | 'enskild_firma') {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: entity, orgNumber: null })
    return { userId, companyId }
  }

  async function insertAccount(companyId: string, userId: string, account: string, sru: string | null) {
    const { rows } = await getPool().query<{ sru_code: string | null }>(
      `INSERT INTO public.chart_of_accounts (id, company_id, user_id, account_number, account_name, account_class, account_type, normal_balance, sru_code)
       VALUES ($1, $2, $3, $4, 'Test', $5, $6, $7, $8)
       RETURNING sru_code`,
      [
        randomUUID(), companyId, userId, account, Number(account[0]),
        account[0] === '1' ? 'asset' : account[0] === '2' ? 'liability' : account[0] === '3' ? 'revenue' : 'expense',
        account[0] === '1' || Number(account[0]) >= 4 ? 'debit' : 'credit',
        sru,
      ],
    )
    return rows[0].sru_code
  }

  it('derives the code on insert, overriding an invented one', async () => {
    const { userId, companyId } = await companyOf('aktiebolag')
    expect(await insertAccount(companyId, userId, '1930', '7301')).toBe('7281')
    expect(await insertAccount(companyId, userId, '3001', null)).toBe('7410')
  })

  it('uses NE codes for an enskild firma', async () => {
    const { userId, companyId } = await companyOf('enskild_firma')
    expect(await insertAccount(companyId, userId, '1930', null)).toBe('7280')
    expect(await insertAccount(companyId, userId, '5010', null)).toBe('7501')
  })

  it('rejects an update to a code that is not on the form', async () => {
    const { userId, companyId } = await companyOf('aktiebolag')
    await insertAccount(companyId, userId, '1930', null)
    await expect(
      getPool().query(`UPDATE public.chart_of_accounts SET sru_code = '7203' WHERE company_id = $1 AND account_number = '1930'`, [companyId]),
    ).rejects.toMatchObject({ code: '22023' })
    await expect(
      getPool().query(`UPDATE public.chart_of_accounts SET sru_code = '7271' WHERE company_id = $1 AND account_number = '1930'`, [companyId]),
    ).resolves.toBeDefined()
  })
})
