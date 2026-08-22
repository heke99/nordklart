import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, withServiceRole, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'

/**
 * The whole point of skatteverket_ombud_authorizations is that `status =
 * 'active'` cannot be reached except from an observed Skatteverket response.
 * A filing the product believes it is authorised to make, and Skatteverket does
 * not, fails at the deadline — so these tests attack the write path rather than
 * exercise it.
 */
async function observe(
  companyId: string,
  orgNumber: string,
  authFlow: string,
  observation: Record<string, unknown>,
) {
  // require_service_role() reads the JWT claim, not the PostgreSQL role, so
  // connecting as superuser is not enough — see tests/pg/setup.ts.
  return withServiceRole(async (client) => {
    const { rows } = await client.query(
      'SELECT public.record_skv_ombud_observation($1, $2, $3, $4::jsonb) AS result',
      [companyId, orgNumber, authFlow, JSON.stringify(observation)],
    )
    return rows[0].result as { status: string; source: string; changed: boolean }
  })
}

async function setup() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId, orgNumber: '5566778899' }
}

describe('skatteverket_ombud_authorizations (pg-real)', () => {
  it('turns a successful call into active and a behörighet refusal into denied', async () => {
    const { companyId, orgNumber } = await setup()

    const granted = await observe(companyId, orgNumber, 'per_bankid', {
      kind: 'skv_response',
      authorized: true,
      correlation_id: 'corr-1',
      status_code: 200,
      operation: 'agdInlamning',
    })
    expect(granted).toMatchObject({ status: 'active', source: 'skv_response', changed: true })

    const refused = await observe(companyId, orgNumber, 'per_bankid', {
      kind: 'skv_response',
      authorized: false,
      correlation_id: 'corr-2',
      status_code: 403,
      skv_error_code: 'BEHORIGHET_SAKNAS',
    })
    expect(refused).toMatchObject({ status: 'denied', source: 'skv_response' })

    const { rows } = await getPool().query(
      'SELECT status, evidence, observed_at FROM public.skatteverket_ombud_authorizations WHERE company_id = $1',
      [companyId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('denied')
    expect(rows[0].observed_at).not.toBeNull()
    // Evidence carries the correlation, not the response body.
    expect(rows[0].evidence).toMatchObject({ correlation_id: 'corr-2', status_code: 403 })
    expect(Object.keys(rows[0].evidence)).not.toContain('body')
  })

  it('records a user assertion as claimed, never as active', async () => {
    const { companyId, userId, orgNumber } = await setup()

    const claimed = await observe(companyId, orgNumber, 'ccg_sysorg', {
      kind: 'manual_attestation',
      claimed_by: userId,
    })
    expect(claimed).toMatchObject({ status: 'claimed', source: 'manual_attestation' })

    const { rows } = await getPool().query(
      `SELECT status, claimed_by, claimed_at, observed_at
         FROM public.skatteverket_ombud_authorizations
        WHERE company_id = $1 AND auth_flow = 'ccg_sysorg'`,
      [companyId],
    )
    expect(rows[0].status).toBe('claimed')
    expect(rows[0].claimed_by).toBe(userId)
    expect(rows[0].observed_at).toBeNull()
  })

  it('refuses to let a user assertion overwrite what Skatteverket said', async () => {
    const { companyId, userId, orgNumber } = await setup()

    await observe(companyId, orgNumber, 'per_bankid', {
      kind: 'skv_response', authorized: false, correlation_id: 'c', status_code: 403,
    })

    const attempted = await observe(companyId, orgNumber, 'per_bankid', {
      kind: 'manual_attestation', claimed_by: userId,
    })
    // Reported back honestly rather than silently ignored.
    expect(attempted).toMatchObject({ status: 'denied', source: 'skv_response', changed: false })

    const { rows } = await getPool().query(
      'SELECT status FROM public.skatteverket_ombud_authorizations WHERE company_id = $1',
      [companyId],
    )
    expect(rows[0].status).toBe('denied')
  })

  it('keeps the auth flows separate', async () => {
    const { companyId, orgNumber } = await setup()
    await observe(companyId, orgNumber, 'per_bankid', {
      kind: 'skv_response', authorized: true, correlation_id: 'a', status_code: 200,
    })
    const { rows } = await getPool().query(
      `SELECT auth_flow, status FROM public.skatteverket_ombud_authorizations
        WHERE company_id = $1 ORDER BY auth_flow`,
      [companyId],
    )
    // Authorising the user's own BankID session says nothing about the
    // organisation certificate.
    expect(rows).toEqual([{ auth_flow: 'per_bankid', status: 'active' }])
  })

  it('rejects an unknown observation kind rather than defaulting', async () => {
    const { companyId, orgNumber } = await setup()
    await expect(
      observe(companyId, orgNumber, 'per_bankid', { kind: 'assume_ok', authorized: true }),
    ).rejects.toThrow(/okänd observationstyp/)
  })

  it('blocks a direct write, even from a privileged connection', async () => {
    const { companyId, orgNumber } = await setup()

    // The guard trigger is what makes "only the RPC writes this" a rule rather
    // than a convention: a service-role code path that decided to INSERT an
    // active row by hand is refused too.
    await expect(
      getPool().query(
        `INSERT INTO public.skatteverket_ombud_authorizations
           (company_id, org_number, auth_flow, status, source, evidence, observed_at)
         VALUES ($1, $2, 'per_bankid', 'active', 'skv_response', '{}'::jsonb, now())`,
        [companyId, orgNumber],
      ),
    ).rejects.toThrow(/record_skv_ombud_observation/)

    await observe(companyId, orgNumber, 'per_bankid', {
      kind: 'skv_response', authorized: false, correlation_id: 'c', status_code: 403,
    })
    await expect(
      getPool().query(
        `UPDATE public.skatteverket_ombud_authorizations
            SET status = 'active' WHERE company_id = $1`,
        [companyId],
      ),
    ).rejects.toThrow(/record_skv_ombud_observation/)
  })

  it('refuses active without an observation even if the guard is bypassed', async () => {
    const { companyId, orgNumber, userId } = await setup()

    // Set the guard flag by hand to prove the CHECK constraints are a second,
    // independent line: status is tied to evidence by the schema, not only by
    // the function that writes it. Transaction-local and rolled back, so the
    // flag cannot leak to the next user of the pooled connection.
    for (const [sql, params, expected] of [
      [
        `INSERT INTO public.skatteverket_ombud_authorizations
           (company_id, org_number, auth_flow, status, source)
         VALUES ($1, $2, 'per_bankid', 'active', 'manual_attestation')`,
        [companyId, orgNumber],
        /skv_ombud_active_requires_response/,
      ],
      [
        `INSERT INTO public.skatteverket_ombud_authorizations
           (company_id, org_number, auth_flow, status, source, claimed_by)
         VALUES ($1, $2, 'org_acg', 'claimed', 'skv_response', $3)`,
        [companyId, orgNumber, userId],
        /skv_ombud_claimed_requires_claimant/,
      ],
    ] as Array<[string, unknown[], RegExp]>) {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        await client.query("SELECT set_config('nordklart.skv_ombud_write', 'on', true)")
        await expect(client.query(sql, params)).rejects.toThrow(expected)
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    }
  })

  it('is readable by the company members and nobody else', async () => {
    const { companyId, orgNumber } = await setup()
    await observe(companyId, orgNumber, 'per_bankid', {
      kind: 'skv_response', authorized: true, correlation_id: 'a', status_code: 200,
    })

    const outsider = await insertAuthUser()
    await withUserContext(outsider, async (client) => {
      const { rows } = await client.query(
        'SELECT id FROM public.skatteverket_ombud_authorizations WHERE company_id = $1',
        [companyId],
      )
      expect(rows).toHaveLength(0)
    })
  })

  it('does not let a member write through their own session', async () => {
    const { companyId, userId, orgNumber } = await setup()
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.skatteverket_ombud_authorizations
             (company_id, org_number, auth_flow, status, source)
           VALUES ($1, $2, 'per_bankid', 'unknown', 'none')`,
          [companyId, orgNumber],
        ),
      ).rejects.toThrow()

      // And the RPC itself is service-role only.
      await expect(
        client.query(
          `SELECT public.record_skv_ombud_observation($1, $2, 'per_bankid', '{"kind":"skv_response","authorized":true}'::jsonb)`,
          [companyId, orgNumber],
        ),
      ).rejects.toThrow()
    })
  })
})
