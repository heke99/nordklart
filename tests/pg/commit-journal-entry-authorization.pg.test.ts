import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, openUserTx, withServiceRole } from './setup'
import {
  insertAuthUser,
  insertCompanyMember,
  seedCompany,
} from './fixtures'

/**
 * commit_journal_entry must authorize its caller.
 *
 * It is SECURITY DEFINER and EXECUTE is granted to authenticated by default. It
 * used auth.uid() only as an attribution fallback when writing
 * voucher_sequences.user_id, and nowhere as an authorization check — so any
 * authenticated user holding another company's id and a draft entry id could
 * post that company's voucher.
 *
 * That is not a read leak. Posted entries are immutable by law (BFL 7 kap,
 * enforced by enforce_journal_entry_immutability), so the victim cannot edit or
 * delete the result — only storno it, leaving both vouchers in their ledger
 * permanently. Someone else's books, corrupted irreversibly.
 *
 * The same call as `anon` also reached voucher-number assignment before failing
 * one statement later, and only because a non-definer balance trigger lacks
 * SELECT on journal_entry_lines for that role. An incidental table grant is not
 * an access control, which is why the check lives in the function.
 */

async function stageDraft(seed: {
  userId: string
  companyId: string
  fiscalPeriodId: string
}): Promise<string> {
  const entryId = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', '2026-06-01', 'Utkast', 'manual', 'draft')`,
    [entryId, seed.userId, seed.companyId, seed.fiscalPeriodId],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', 777, 0), ($1, '3001', 0, 777)`,
    [entryId],
  )
  return entryId
}

async function entryState(entryId: string) {
  const { rows } = await getPool().query<{ status: string; voucher_number: number }>(
    `SELECT status, voucher_number FROM public.journal_entries WHERE id = $1`,
    [entryId],
  )
  return rows[0]
}

async function commitAs(userId: string, companyId: string, entryId: string) {
  const tx = await openUserTx(userId)
  try {
    const result = await tx.client.query(
      `SELECT public.commit_journal_entry($1::uuid, $2::uuid)`,
      [companyId, entryId],
    )
    await tx.commit()
    return result
  } finally {
    await tx.rollback()
  }
}

describe('commit_journal_entry authorization', () => {
  it('refuses a member of another company', async () => {
    const victim = await seedCompany()
    const attacker = await seedCompany()
    const entryId = await stageDraft(victim)

    let raised: unknown
    try {
      await commitAs(attacker.userId, victim.companyId, entryId)
    } catch (error) {
      raised = error
    }

    expect(raised, 'a foreign member must not be able to post this voucher').toBeDefined()
    expect((raised as { code?: string }).code).toBe('42501')
    expect((raised as { detail?: string }).detail).toContain('COMPANY_WRITE_FORBIDDEN')

    const state = await entryState(entryId)
    expect(state.status).toBe('draft')
    expect(state.voucher_number).toBe(0)
  })

  it('refuses a user with no company membership at all', async () => {
    const victim = await seedCompany()
    const stranger = await insertAuthUser()
    const entryId = await stageDraft(victim)

    let raised: unknown
    try {
      await commitAs(stranger, victim.companyId, entryId)
    } catch (error) {
      raised = error
    }
    expect(raised).toBeDefined()
    expect((await entryState(entryId)).status).toBe('draft')
  })

  it('refuses a viewer of the same company', async () => {
    // Read access is not write access. A viewer must not be able to post.
    const seed = await seedCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: seed.companyId, userId: viewerId, role: 'viewer' })
    const entryId = await stageDraft(seed)

    let raised: unknown
    try {
      await commitAs(viewerId, seed.companyId, entryId)
    } catch (error) {
      raised = error
    }
    expect(raised).toBeDefined()
    expect((raised as { detail?: string }).detail).toContain('COMPANY_WRITE_FORBIDDEN')
    expect((await entryState(entryId)).status).toBe('draft')
  })

  it('still lets the owner post their own voucher', async () => {
    // The half that matters just as much: the fix must not break the product.
    const seed = await seedCompany()
    const entryId = await stageDraft(seed)

    await commitAs(seed.userId, seed.companyId, entryId)

    const state = await entryState(entryId)
    expect(state.status).toBe('posted')
    expect(state.voucher_number).toBeGreaterThan(0)
  })

  it('still lets an internal service-role caller post without an actor', async () => {
    // Every settlement, SIE reversal and year-end path reaches this function
    // with no auth.uid(). Blocking those would break all of them.
    const seed = await seedCompany()
    const entryId = await stageDraft(seed)

    await withServiceRole((client) => client.query(
      `SELECT public.commit_journal_entry($1::uuid, $2::uuid, 'automation')`,
      [seed.companyId, entryId],
    ))

    const state = await entryState(entryId)
    expect(state.status).toBe('posted')
    expect(state.voucher_number).toBeGreaterThan(0)
  })

  it('does not grant anon execute on the function', async () => {
    // On Supabase this is not the same statement as "PUBLIC has no grant".
    // The platform image runs ALTER DEFAULT PRIVILEGES granting all on
    // functions in public to anon, so every function is created with an
    // EXPLICIT anon grant that REVOKE ... FROM PUBLIC leaves untouched. This
    // assertion passed on plain PostgreSQL and failed on the real image —
    // which is the whole reason pg-real runs against supabase/postgres.
    const { rows } = await getPool().query<{ allowed: boolean }>(
      `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS allowed
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'commit_journal_entry'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].allowed).toBe(false)
  })

  it('keeps the grant that authenticated callers need', async () => {
    // The revoke must not overshoot — the dashboard commits as `authenticated`.
    const { rows } = await getPool().query<{ allowed: boolean }>(
      `SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') AS allowed
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'commit_journal_entry'`,
    )
    expect(rows[0].allowed).toBe(true)
  })

  it('refuses an anon caller even when it can reach the function', async () => {
    // The grant is one layer; this is the other. A restore, a fresh database or
    // an operator re-running the default-privileges statement can hand anon
    // EXECUTE back, and the body must still refuse. It matters more than usual
    // here because auth.uid() is NULL for anon, so the write check below it
    // does not fire — the function would otherwise post the voucher.
    const seed = await seedCompany()
    const entryId = await stageDraft(seed)

    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('request.jwt.claims', '{"role":"anon"}', true)`,
      )
      await expect(
        client.query(
          `SELECT public.commit_journal_entry($1::uuid, $2::uuid, 'manual')`,
          [seed.companyId, entryId],
        ),
      ).rejects.toThrow(/Anonymous callers cannot commit/i)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }

    const state = await entryState(entryId)
    expect(state.status).toBe('draft')
    // stageDraft seeds voucher_number 0; a real commit replaces it with the
    // next number in the series, so 0 means nothing was assigned.
    expect(state.voucher_number).toBe(0)
  })
})
