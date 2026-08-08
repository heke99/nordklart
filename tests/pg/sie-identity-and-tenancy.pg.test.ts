import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * SIE organisation identity and tenancy.
 *
 * compare_sie_company_identity is the check standing between a user and
 * importing somebody else's general ledger into their own company. A SIE file
 * carries #ORGNR, and accepting a file whose organisation number does not match
 * the receiving company means booking another legal entity's verifikationer as
 * your own — a BFL 5 kap problem, not a UX one.
 *
 * The function had no test at all, so neither its match semantics nor its
 * treatment of a missing number on either side was pinned.
 */

async function compareIdentity(sie: string | null, company: string | null): Promise<string> {
  const { rows } = await getPool().query<{ result: string }>(
    `SELECT public.compare_sie_company_identity($1, $2) AS result`,
    [sie, company],
  )
  return rows[0].result
}

describe('compare_sie_company_identity', () => {
  it('matches the same organisation number across formatting differences', async () => {
    // Swedish org numbers are written with and without the hyphen, and with or
    // without the century prefix. All of these are the same legal entity, and
    // rejecting a legitimate file is as harmful as accepting a foreign one.
    const canonical = '5560000001'
    for (const written of ['5560000001', '556000-0001', '165560000001']) {
      expect(await compareIdentity(written, canonical), written).toBe('match')
    }
  })

  it('reports a mismatch for a different organisation number', async () => {
    expect(await compareIdentity('5560000001', '5569999999')).toBe('mismatch')
  })

  it('distinguishes which side is missing the number', async () => {
    // The two are different user-facing situations: a file without #ORGNR can
    // be accepted with a warning, while a company that has not recorded its own
    // number cannot verify anything and must be completed first.
    expect(await compareIdentity(null, '5560000001')).toBe('missing_in_sie')
    expect(await compareIdentity('', '5560000001')).toBe('missing_in_sie')
    expect(await compareIdentity('5560000001', null)).toBe('missing_in_company')
    expect(await compareIdentity(null, null)).toBe('missing_in_sie')
  })

  it('treats an unparseable organisation number as missing rather than matching', async () => {
    // Failing open here would let any garbage #ORGNR pass as a match.
    for (const junk of ['not-a-number', '123', '55600000019999999']) {
      expect(await compareIdentity(junk, '5560000001'), junk).not.toBe('match')
    }
  })
})

describe('SIE imports are scoped to their company', () => {
  it('does not expose another company import through RLS', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    const importId = randomUUID()
    await getPool().query(
      `INSERT INTO public.sie_imports
         (id, user_id, company_id, filename, file_hash, sie_type, status,
          total_vouchers, posted_vouchers, skipped_duplicate_vouchers, failed_vouchers)
       VALUES ($1, $2, $3, 'bokforing.se', $4, '4', 'pending', 0, 0, 0, 0)`,
      [importId, a.userId, a.companyId, `hash-${randomUUID()}`],
    )

    const visibleToOwner = await withUserContext(a.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM public.sie_imports WHERE id = $1`, [importId],
      )
      return rows.length
    })
    expect(visibleToOwner).toBe(1)

    const visibleToOther = await withUserContext(b.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM public.sie_imports WHERE id = $1`, [importId],
      )
      return rows.length
    })
    expect(visibleToOther).toBe(0)
  })

  it('refuses to undo an import that belongs to another company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    const importId = randomUUID()
    await getPool().query(
      `INSERT INTO public.sie_imports
         (id, user_id, company_id, filename, file_hash, sie_type, status,
          total_vouchers, posted_vouchers, skipped_duplicate_vouchers, failed_vouchers)
       VALUES ($1, $2, $3, 'bokforing.se', $4, '4', 'completed', 1, 1, 0, 0)`,
      [importId, a.userId, a.companyId, `hash-${randomUUID()}`],
    )

    let raised: unknown
    try {
      // Company B naming company A's import id. The company-scoped lookup must
      // not find it, whatever the caller claims.
      await getPool().query(
        `SELECT public.undo_sie_import($1::uuid, $2::uuid)`,
        [b.companyId, importId],
      )
    } catch (error) {
      raised = error
    }

    // Either a raised error or a no-op result is acceptable; silently undoing
    // company A's import is not.
    const { rows } = await getPool().query<{ status: string; replaced_at: string | null }>(
      `SELECT status, replaced_at::text FROM public.sie_imports WHERE id = $1`,
      [importId],
    )
    expect(rows[0].status).toBe('completed')
    expect(rows[0].replaced_at).toBeNull()
    void raised
  })
})
