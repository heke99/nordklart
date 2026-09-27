import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/** Covers 20260927100000_invitations_hardening. */

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

async function emailOf(userId: string) {
  const { rows } = await getPool().query<{ email: string }>(`SELECT email FROM auth.users WHERE id = $1`, [userId])
  return rows[0].email
}

async function seedCompanyInvite(opts: { role?: string; email?: string; expiresIn?: string } = {}) {
  const owner = await insertAuthUser()
  const invitee = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: owner })
  await getPool().query(
    `INSERT INTO public.company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [companyId, owner],
  )
  const token = randomUUID()
  await getPool().query(
    `INSERT INTO public.company_invitations (company_id, email, role, membership_kind, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + $7::interval)`,
    [
      companyId,
      opts.email ?? (await emailOf(invitee)).toUpperCase(),
      opts.role ?? 'member',
      ['viewer', 'accountant', 'auditor'].includes(opts.role ?? 'member') ? 'external' : 'internal',
      hash(token),
      owner,
      opts.expiresIn ?? '7 days',
    ],
  )
  return { owner, invitee, companyId, tokenHash: hash(token) }
}

const accept = async (tokenHash: string, userId: string) => {
  const { rows } = await getPool().query<{ r: Record<string, unknown> }>(
    `SELECT public.accept_invitation($1, $2) AS r`,
    [tokenHash, userId],
  )
  return rows[0].r
}

const membership = async (companyId: string, userId: string) => {
  const { rows } = await getPool().query(
    `SELECT role, status, membership_kind, access_source FROM public.company_members WHERE company_id = $1 AND user_id = $2`,
    [companyId, userId],
  )
  return rows[0]
}

describe('accept_invitation: company', () => {
  it('adds an existing account to the company (e-mail compared case-insensitively)', async () => {
    const s = await seedCompanyInvite({ role: 'accountant' })
    const r = await accept(s.tokenHash, s.invitee)
    expect(r).toMatchObject({ ok: true, type: 'company', company_id: s.companyId, role: 'accountant' })
    expect(await membership(s.companyId, s.invitee)).toMatchObject({
      role: 'accountant', status: 'active', membership_kind: 'external', access_source: 'invite',
    })
    const prefs = await getPool().query(`SELECT active_company_id, active_workspace_type FROM public.user_preferences WHERE user_id = $1`, [s.invitee])
    expect(prefs.rows[0]).toMatchObject({ active_company_id: s.companyId, active_workspace_type: 'company' })
    const inv = await getPool().query(`SELECT status, accepted_by FROM public.company_invitations WHERE token_hash = $1`, [s.tokenHash])
    expect(inv.rows[0]).toMatchObject({ status: 'accepted', accepted_by: s.invitee })
  })

  it('can be accepted only once', async () => {
    const s = await seedCompanyInvite()
    expect(await accept(s.tokenHash, s.invitee)).toMatchObject({ ok: true })
    expect(await accept(s.tokenHash, s.invitee)).toMatchObject({ ok: false, error: 'not_pending' })
  })

  it('refuses another account than the invited e-mail', async () => {
    const s = await seedCompanyInvite()
    const stranger = await insertAuthUser()
    expect(await accept(s.tokenHash, stranger)).toMatchObject({ ok: false, error: 'email_mismatch' })
    expect(await membership(s.companyId, stranger)).toBeUndefined()
  })

  it('marks an expired invitation expired and grants nothing', async () => {
    const s = await seedCompanyInvite({ expiresIn: '-1 minute' })
    expect(await accept(s.tokenHash, s.invitee)).toMatchObject({ ok: false, error: 'expired' })
    const inv = await getPool().query(`SELECT status FROM public.company_invitations WHERE token_hash = $1`, [s.tokenHash])
    expect(inv.rows[0].status).toBe('expired')
    expect(await membership(s.companyId, s.invitee)).toBeUndefined()
  })

  it('never lowers an existing role', async () => {
    const s = await seedCompanyInvite({ role: 'viewer' })
    await getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role, membership_kind) VALUES ($1, $2, 'admin', 'internal')`,
      [s.companyId, s.invitee],
    )
    expect(await accept(s.tokenHash, s.invitee)).toMatchObject({ ok: true, role: 'admin' })
    expect(await membership(s.companyId, s.invitee)).toMatchObject({ role: 'admin', membership_kind: 'internal' })
  })

  it('re-activates a revoked membership but not a suspended one', async () => {
    const revoked = await seedCompanyInvite({ role: 'member' })
    await getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role, status) VALUES ($1, $2, 'viewer', 'revoked')`,
      [revoked.companyId, revoked.invitee],
    )
    expect(await accept(revoked.tokenHash, revoked.invitee)).toMatchObject({ ok: true, role: 'member' })
    expect(await membership(revoked.companyId, revoked.invitee)).toMatchObject({ role: 'member', status: 'active' })

    const suspended = await seedCompanyInvite({ role: 'member' })
    await getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role, status) VALUES ($1, $2, 'member', 'suspended')`,
      [suspended.companyId, suspended.invitee],
    )
    expect(await accept(suspended.tokenHash, suspended.invitee)).toMatchObject({ ok: false, error: 'membership_suspended' })
    expect(await membership(suspended.companyId, suspended.invitee)).toMatchObject({ status: 'suspended' })
  })

  it('refuses an archived company', async () => {
    const s = await seedCompanyInvite()
    await getPool().query(`UPDATE public.companies SET archived_at = now() WHERE id = $1`, [s.companyId])
    expect(await accept(s.tokenHash, s.invitee)).toMatchObject({ ok: false, error: 'company_unavailable' })
  })

  it('returns not_found for an unknown token', async () => {
    const user = await insertAuthUser()
    expect(await accept(hash('nope'), user)).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('is service-role only', async () => {
    const { rows } = await getPool().query(
      `SELECT has_function_privilege('authenticated', 'public.accept_invitation(text,uuid)', 'EXECUTE') AS auth,
              has_function_privilege('anon', 'public.accept_invitation(text,uuid)', 'EXECUTE') AS anon`,
    )
    expect(rows[0]).toEqual({ auth: false, anon: false })
  })
})

describe('company_invitations cannot be used to mint an owner', () => {
  it('an admin cannot insert or update invitations through the API', async () => {
    const owner = await insertAuthUser()
    const admin = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: owner })
    await getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'admin')`,
      [companyId, owner, admin],
    )
    await expect(
      withUserContext(admin, (c) =>
        c.query(
          `INSERT INTO public.company_invitations (company_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, 'me@example.se', 'owner', 'x', $2, now() + interval '1 day')`,
          [companyId, admin],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('the role CHECK refuses owner', async () => {
    const s = await seedCompanyInvite()
    await expect(
      getPool().query(`UPDATE public.company_invitations SET role = 'owner' WHERE token_hash = $1`, [s.tokenHash]),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('admins can list invitations without token_hash; members cannot list them', async () => {
    const s = await seedCompanyInvite()
    const member = await insertAuthUser()
    await getPool().query(
      `INSERT INTO public.company_members (company_id, user_id, role) VALUES ($1, $2, 'member')`,
      [s.companyId, member],
    )
    const asOwner = await withUserContext(s.owner, (c) =>
      c.query(`SELECT id, email FROM public.company_invitations WHERE company_id = $1`, [s.companyId]),
    )
    expect(asOwner.rows).toHaveLength(1)
    await expect(
      withUserContext(s.owner, (c) => c.query(`SELECT token_hash FROM public.company_invitations`)),
    ).rejects.toMatchObject({ code: '42501' })
    const asMember = await withUserContext(member, (c) =>
      c.query(`SELECT id FROM public.company_invitations WHERE company_id = $1`, [s.companyId]),
    )
    expect(asMember.rows).toHaveLength(0)
  })
})

describe('accept_invitation: agency', () => {
  async function seedAgencyInvite(role = 'accountant', withClient = true) {
    const owner = await insertAuthUser()
    const staff = await insertAuthUser()
    const agencyCompany = await insertCompany({ createdBy: owner, name: 'Byrån AB' })
    const agencyId = randomUUID()
    await getPool().query(
      `INSERT INTO public.agencies (id, name, status, created_by, company_id) VALUES ($1, 'Byrån', 'active', $2, $3)`,
      [agencyId, owner, agencyCompany],
    )
    let clientId: string | null = null
    if (withClient) {
      clientId = await insertCompany({ createdBy: owner, name: 'Kund AB' })
      await getPool().query(
        `INSERT INTO public.agency_clients (agency_id, company_id, status) VALUES ($1, $2, 'active')`,
        [agencyId, clientId],
      )
    }
    const token = randomUUID()
    await getPool().query(
      `INSERT INTO public.agency_invitations (agency_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')`,
      [agencyId, await emailOf(staff), role, hash(token), owner],
    )
    return { owner, staff, agencyId, clientId, agencyCompany, tokenHash: hash(token) }
  }

  it('adds the staff member and opens a client they can reach', async () => {
    const s = await seedAgencyInvite()
    const r = await accept(s.tokenHash, s.staff)
    expect(r).toMatchObject({ ok: true, type: 'agency', agency_id: s.agencyId, company_id: s.clientId })
    const m = await getPool().query(`SELECT role, status FROM public.agency_members WHERE agency_id = $1 AND user_id = $2`, [s.agencyId, s.staff])
    expect(m.rows[0]).toMatchObject({ role: 'accountant', status: 'active' })
    const access = await getPool().query(`SELECT can_read FROM public.resolve_company_access_for_user($1, $2)`, [s.staff, s.clientId])
    expect(access.rows[0]?.can_read).toBe(true)
    const prefs = await getPool().query(`SELECT active_company_id, active_workspace_type, active_agency_id FROM public.user_preferences WHERE user_id = $1`, [s.staff])
    expect(prefs.rows[0]).toMatchObject({ active_company_id: s.clientId, active_workspace_type: 'agency', active_agency_id: s.agencyId })
  })

  it('never points the user at the agency\'s own books', async () => {
    const s = await seedAgencyInvite('accountant', false)
    const r = await accept(s.tokenHash, s.staff)
    expect(r).toMatchObject({ ok: true, company_id: null })
    const prefs = await getPool().query(`SELECT active_company_id FROM public.user_preferences WHERE user_id = $1`, [s.staff])
    expect(prefs.rows[0].active_company_id).not.toBe(s.agencyCompany)
  })

  it('does not lower an agency owner and does not lift a suspension', async () => {
    const owner = await seedAgencyInvite('read_only')
    await getPool().query(
      `INSERT INTO public.agency_members (agency_id, user_id, role, status) VALUES ($1, $2, 'agency_admin', 'active')`,
      [owner.agencyId, owner.staff],
    )
    expect(await accept(owner.tokenHash, owner.staff)).toMatchObject({ ok: true, role: 'agency_admin' })

    const suspended = await seedAgencyInvite('accountant')
    await getPool().query(
      `INSERT INTO public.agency_members (agency_id, user_id, role, status) VALUES ($1, $2, 'accountant', 'suspended')`,
      [suspended.agencyId, suspended.staff],
    )
    expect(await accept(suspended.tokenHash, suspended.staff)).toMatchObject({ ok: false, error: 'membership_suspended' })
  })

  it('agency admins cannot read token_hash', async () => {
    const s = await seedAgencyInvite()
    await getPool().query(
      `INSERT INTO public.agency_members (agency_id, user_id, role, status) VALUES ($1, $2, 'agency_owner', 'active')`,
      [s.agencyId, s.owner],
    )
    const rows = await withUserContext(s.owner, (c) =>
      c.query(`SELECT id, email, status FROM public.agency_invitations WHERE agency_id = $1`, [s.agencyId]),
    )
    expect(rows.rows).toHaveLength(1)
    await expect(
      withUserContext(s.owner, (c) => c.query(`SELECT token_hash FROM public.agency_invitations`)),
    ).rejects.toMatchObject({ code: '42501' })
  })
})
