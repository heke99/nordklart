import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/** Covers 20260925111000_approve_access_request_atomic. */
async function seed(existing?: { role: string; status: string }) {
  const owner = await insertAuthUser()
  const requester = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: owner })
  if (existing) {
    await getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role, status) VALUES ($1, $2, $3, $4)`,
      [companyId, requester, existing.role, existing.status],
    )
  }
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.company_access_requests (company_id, requester_user_id, requester_email)
     VALUES ($1, $2, 'r@example.se') RETURNING id`,
    [companyId, requester],
  )
  return { owner, requester, companyId, requestId: rows[0].id }
}

const approve = (requestId: string, companyId: string, role: string, actor: string) =>
  getPool().query(`SELECT * FROM public.approve_company_access_request($1, $2, $3, $4)`, [requestId, companyId, role, actor])

describe('approve_company_access_request', () => {
  it('creates the membership and marks the request approved together', async () => {
    const s = await seed()
    await approve(s.requestId, s.companyId, 'accountant', s.owner)
    const m = await getPool().query(`SELECT role, status, membership_kind FROM public.company_members WHERE company_id = $1 AND user_id = $2`, [s.companyId, s.requester])
    expect(m.rows[0]).toMatchObject({ role: 'accountant', status: 'active', membership_kind: 'external' })
    const r = await getPool().query(`SELECT status, reviewed_by FROM public.company_access_requests WHERE id = $1`, [s.requestId])
    expect(r.rows[0]).toMatchObject({ status: 'approved', reviewed_by: s.owner })
  })

  it('refuses a second approval', async () => {
    const s = await seed()
    await approve(s.requestId, s.companyId, 'member', s.owner)
    await expect(approve(s.requestId, s.companyId, 'member', s.owner)).rejects.toMatchObject({ code: '55000' })
  })

  it('never lowers an active member role', async () => {
    const s = await seed({ role: 'admin', status: 'active' })
    const { rows } = await approve(s.requestId, s.companyId, 'viewer', s.owner)
    expect(rows[0].role).toBe('admin')
    const m = await getPool().query(`SELECT role FROM public.company_members WHERE company_id = $1 AND user_id = $2`, [s.companyId, s.requester])
    expect(m.rows[0].role).toBe('admin')
  })

  it('does not approve a request of another company', async () => {
    const s = await seed()
    const other = await insertCompany({ createdBy: s.owner })
    await expect(approve(s.requestId, other, 'member', s.owner)).rejects.toMatchObject({ code: 'P0002' })
  })

  it('is not executable by authenticated users', async () => {
    const { rows } = await getPool().query(
      `SELECT has_function_privilege('authenticated', 'public.approve_company_access_request(uuid,uuid,text,uuid)', 'EXECUTE') AS ok`,
    )
    expect(rows[0].ok).toBe(false)
  })
})

describe('external company roles', () => {
  it('company_invitations and company_members accept accountant and auditor', async () => {
    const owner = await insertAuthUser()
    const other = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: owner })
    await expect(getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role) VALUES ($1, $2, 'auditor')`,
      [companyId, other],
    )).resolves.toBeDefined()
    await expect(getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role) VALUES ($1, $2, 'superuser')`,
      [companyId, owner],
    )).rejects.toMatchObject({ code: '23514' })
  })
})
