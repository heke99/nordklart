import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
} from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260709120000_bank_sync_runs_payment_initiations:
 *   - payment_initiations RLS: members read their company's rows; other
 *     companies' rows are invisible.
 *   - Delete protection trigger: exported files are räkenskapsinformation
 *     (BFL 7 kap) — DELETE raises; rows still in 'created' may be deleted.
 *   - bank_sync_runs RLS: company-scoped select.
 */

async function insertInitiation(params: {
  companyId: string
  userId: string
  status?: string
  messageId?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.payment_initiations
       (id, company_id, user_id, kind, method, message_id, status,
        payment_date, total_amount, payment_count, file_name, file_content)
     VALUES ($1, $2, $3, 'supplier_payment', 'pain001', $4, $5,
             '2026-07-15', 1000, 1, 'test.xml', '<xml/>')`,
    [id, params.companyId, params.userId, params.messageId ?? `MSG-${id.slice(0, 8)}`, params.status ?? 'exported'],
  )
  return id
}

describe('payment_initiations RLS + delete protection', () => {
  it('members can read own company rows; other companies are invisible', async () => {
    const userA = await insertAuthUser()
    const userB = await insertAuthUser()
    const companyA = await insertCompany({ createdBy: userA })
    const companyB = await insertCompany({ createdBy: userB })
    await insertCompanyMember({ companyId: companyA, userId: userA, role: 'owner' })
    await insertCompanyMember({ companyId: companyB, userId: userB, role: 'owner' })

    const rowA = await insertInitiation({ companyId: companyA, userId: userA })
    await insertInitiation({ companyId: companyB, userId: userB })

    await withUserContext(userA, async (client) => {
      const { rows } = await client.query(
        `SELECT id, company_id FROM public.payment_initiations`,
      )
      expect(rows.some((r) => r.id === rowA)).toBe(true)
      expect(rows.every((r) => r.company_id === companyA)).toBe(true)
    })
  })

  it('blocks DELETE of exported payment files (BFL 7 kap)', async () => {
    const user = await insertAuthUser()
    const company = await insertCompany({ createdBy: user })
    await insertCompanyMember({ companyId: company, userId: user, role: 'owner' })
    const exported = await insertInitiation({ companyId: company, userId: user, status: 'exported' })

    await expect(
      getPool().query(`DELETE FROM public.payment_initiations WHERE id = $1`, [exported]),
    ).rejects.toThrow(/räkenskapsinformation/)
  })

  it('allows DELETE while still in created status (never exported)', async () => {
    const user = await insertAuthUser()
    const company = await insertCompany({ createdBy: user })
    await insertCompanyMember({ companyId: company, userId: user, role: 'owner' })
    const created = await insertInitiation({ companyId: company, userId: user, status: 'created' })

    const result = await getPool().query(
      `DELETE FROM public.payment_initiations WHERE id = $1`,
      [created],
    )
    expect(result.rowCount).toBe(1)
  })

  it('enforces unique message_id per company', async () => {
    const user = await insertAuthUser()
    const company = await insertCompany({ createdBy: user })
    await insertCompanyMember({ companyId: company, userId: user, role: 'owner' })
    await insertInitiation({ companyId: company, userId: user, messageId: 'DUP-1', status: 'created' })
    await expect(
      insertInitiation({ companyId: company, userId: user, messageId: 'DUP-1', status: 'created' }),
    ).rejects.toThrow(/duplicate key/)
  })
})

describe('bank_sync_runs RLS', () => {
  it('company members read only their own sync runs', async () => {
    const userA = await insertAuthUser()
    const userB = await insertAuthUser()
    const companyA = await insertCompany({ createdBy: userA })
    const companyB = await insertCompany({ createdBy: userB })
    await insertCompanyMember({ companyId: companyA, userId: userA, role: 'owner' })
    await insertCompanyMember({ companyId: companyB, userId: userB, role: 'owner' })

    const runA = randomUUID()
    const runB = randomUUID()
    await getPool().query(
      `INSERT INTO public.bank_sync_runs (id, company_id, trigger_source, status)
       VALUES ($1, $2, 'manual', 'success'), ($3, $4, 'cron', 'failed')`,
      [runA, companyA, runB, companyB],
    )

    await withUserContext(userA, async (client) => {
      const { rows } = await client.query(`SELECT id, company_id FROM public.bank_sync_runs`)
      expect(rows.some((r) => r.id === runA)).toBe(true)
      expect(rows.some((r) => r.id === runB)).toBe(false)
    })
  })
})
