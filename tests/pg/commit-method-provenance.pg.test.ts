import { describe, expect, it } from 'vitest'
import {
  seedCompany,
  insertDraftJournalEntry,
  insertBalancedLines,
} from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Covers 20260618120001_commit_method_agent_provenance:
 *   - journal_entries.commit_method accepts the new 'agent' and 'api_key'
 *     values (MCP-relayed approvals — agent_first_vision.md §8 P0-1).
 *   - The pre-existing values are still accepted.
 *   - Unknown values are still rejected by the CHECK constraint.
 *   - Exactly one commit_method constraint exists (guards against the
 *     DROP CONSTRAINT IF EXISTS missing a differently-named original, which
 *     would leave the old, narrower CHECK in force).
 */

async function postWithCommitMethod(commitMethod: string): Promise<string> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
  await insertBalancedLines(entryId)
  // draft → posted with commit metadata — same transition the commit RPC does.
  await getPool().query(
    `UPDATE public.journal_entries
       SET status = 'posted', voucher_number = 1, commit_method = $2
     WHERE id = $1`,
    [entryId, commitMethod],
  )
  return entryId
}

describe('journal_entries.commit_method — agent provenance values', () => {
  it.each(['agent', 'api_key', 'user_accept', 'bulk_accept'])(
    'accepts commit_method=%s',
    async (method) => {
      const entryId = await postWithCommitMethod(method)
      const { rows } = await getPool().query(
        `SELECT commit_method, status FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      expect(rows[0]).toEqual({ commit_method: method, status: 'posted' })
    },
  )

  it('rejects values outside the CHECK list', async () => {
    await expect(postWithCommitMethod('robot')).rejects.toMatchObject({
      // 23514 = check_violation
      code: '23514',
    })
  })

  it('exactly one commit_method CHECK constraint exists, under the canonical name', async () => {
    const { rows } = await getPool().query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'public.journal_entries'::regclass
          AND conname LIKE '%commit_method%'`,
    )
    expect(rows.map((r) => r.conname)).toEqual(['journal_entries_commit_method_check'])
  })
})

/**
 * Drift guard: every commit_method literal any database function can write must
 * be permitted by the CHECK constraint on journal_entries.
 *
 * This exact class of drift shipped to production twice. settle_customer_invoice
 * and settle_supplier_invoice both committed with 'atomic_customer_settlement' /
 * 'atomic_supplier_settlement' while their own constraint still forbade those
 * values, so EVERY customer and supplier payment failed; and the SIE undo path
 * committed with 'sie_import_reversal' under the same constraint. Both were
 * introduced by a migration that added a writer without widening the constraint,
 * and both were invisible to the suite because no test drove the success path.
 *
 * Comparing the two sides directly makes the next one impossible to miss, and
 * does not depend on anyone remembering to write a happy-path test for the new
 * writer.
 */
describe('commit_method writers agree with the CHECK constraint', () => {
  async function allowedValues(): Promise<Set<string>> {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'public.journal_entries'::regclass
         AND conname LIKE '%commit_method%'`,
    )
    expect(rows).toHaveLength(1)
    return new Set(
      [...rows[0].def.matchAll(/'([a-z0-9_]+)'::text/g)].map((match) => match[1]),
    )
  }

  /**
   * Literals each function can hand to commit_journal_entry, whose third
   * argument is the commit method. Read from the live catalog so a function
   * redefined by a later migration is judged on the definition that actually
   * survived.
   */
  async function writtenValues(): Promise<Map<string, string[]>> {
    const { rows } = await getPool().query<{ name: string; src: string }>(
      `SELECT p.proname AS name, p.prosrc AS src
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND (p.prosrc ~ 'commit_journal_entry' OR p.prosrc ~ 'commit_method')
       ORDER BY p.proname`,
    )
    const found = new Map<string, string[]>()
    for (const row of rows) {
      const literals = new Set<string>()
      // commit_journal_entry(company, entry, 'method', ...)
      for (const match of row.src.matchAll(
        /commit_journal_entry\s*\([^;]*?,\s*'([a-z0-9_]+)'/gi,
      )) literals.add(match[1])
      // Direct writes: commit_method = 'method' / commit_method := 'method'
      for (const match of row.src.matchAll(
        /commit_method\s*(?::?=)\s*'([a-z0-9_]+)'/gi,
      )) literals.add(match[1])
      if (literals.size > 0) found.set(row.name, [...literals].sort())
    }
    return found
  }

  it('permits every literal the database functions actually write', async () => {
    const allowed = await allowedValues()
    const writers = await writtenValues()

    // If the extraction stops matching, the guard stops guarding. Both known
    // settlement writers must be visible for the comparison to mean anything.
    expect(writers.size).toBeGreaterThan(0)
    expect([...writers.keys()]).toEqual(
      expect.arrayContaining(['settle_customer_invoice_v2', 'settle_supplier_invoice_v2']),
    )

    const violations: string[] = []
    for (const [name, literals] of writers) {
      for (const literal of literals) {
        if (!allowed.has(literal)) violations.push(`${name} writes '${literal}'`)
      }
    }

    expect(
      violations,
      `These functions commit with a commit_method their own CHECK constraint `
      + `forbids, so every call fails at runtime. Allowed: ${[...allowed].sort().join(', ')}. `
      + `Widen the constraint in a forward migration, or correct the writer.`,
    ).toEqual([])
  })

  it('keeps the values the two production incidents needed', async () => {
    const allowed = await allowedValues()
    for (const value of [
      'sie_import_reversal',
      'atomic_customer_settlement',
      'atomic_supplier_settlement',
    ]) {
      expect(allowed, `${value} was removed from the constraint`).toContain(value)
    }
  })

  it('accepts each allowed value against the real constraint', async () => {
    // The constraint text and the constraint's behaviour are different things;
    // a value listed but rejected would still break every writer using it.
    const allowed = await allowedValues()
    for (const value of allowed) {
      const entryId = await postWithCommitMethod(value)
      const { rows } = await getPool().query<{ commit_method: string }>(
        `SELECT commit_method FROM public.journal_entries WHERE id = $1`,
        [entryId],
      )
      expect(rows[0].commit_method, value).toBe(value)
    }
  })
})

describe('__year_end_prior_result_transfer commits the omföring voucher', () => {
  /**
   * The second consecutive year-end close of an aktiebolag transfers the prior
   * year's result from 2099 to 2098. That path commits with
   * commit_method = 'system', which the CHECK constraint rejected until
   * 20260808140000 — so every AB closing its second year aborted with 23514.
   *
   * Driven through commit_journal_entry with the exact arguments the function
   * passes, because the bug was in the argument, not in the surrounding logic.
   */
  it('accepts the exact commit call the transfer makes', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()
    const entryId = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await getPool().query(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, line_description, sort_order)
       VALUES ($1, '2098', 100, 0, 'Föregående års resultat', 0),
              ($1, '2099', 0, 100, 'Omföring av föregående års resultat', 1)`,
      [entryId],
    )

    await getPool().query(
      `SELECT public.commit_journal_entry($1::uuid, $2::uuid, 'system',
         'prior-year-result-transfer', 'system', 'execute_year_end_closing')`,
      [companyId, entryId],
    )

    const { rows } = await getPool().query<{
      status: string; commit_method: string
      committed_actor_type: string | null; committed_actor_label: string | null
    }>(
      `SELECT status, commit_method, committed_actor_type, committed_actor_label
       FROM public.journal_entries WHERE id = $1`,
      [entryId],
    )
    expect(rows[0].status).toBe('posted')
    expect(rows[0].commit_method).toBe('system')
    // The provenance the commit_method 'system' is consistent with.
    expect(rows[0].committed_actor_type).toBe('system')
    expect(rows[0].committed_actor_label).toBe('execute_year_end_closing')
  })
})
