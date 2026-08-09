import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'

/**
 * Covers 20260807120000_secure_migration_ledger_and_pin_search_path.sql.
 *
 * Both halves of that migration are conditional (the ledger table is created by
 * the runner script, not by a migration), so these tests assert the *outcome*
 * on whatever the migrated database actually contains rather than assuming the
 * table exists.
 */
describe('migration ledger and trigger search_path hardening', () => {
  it('never exposes the migration ledger to PostgREST roles', async () => {
    const { rows } = await getPool().query<{
      relrowsecurity: boolean
      anon_select: boolean
      authenticated_select: boolean
    }>(`
      SELECT
        c.relrowsecurity,
        has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
        has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'nordklart_schema_migrations'
    `)

    // Absent in a freshly migrated test database — the runner creates it. When
    // it is present (as in production), it must be locked down.
    if (rows.length === 0) return

    expect(rows[0].relrowsecurity).toBe(true)
    expect(rows[0].anon_select).toBe(false)
    expect(rows[0].authenticated_select).toBe(false)
  })

  it('pins search_path on the accounting-critical trigger functions', async () => {
    const targets = [
      'enforce_journal_entry_line_immutability',
      'enforce_retention_journal_entries',
      'next_voucher_number',
      'detect_voucher_gaps',
      'enforce_company_lock_date',
      'enforce_company_member_role_transitions',
      'enforce_company_member_role_on_insert',
      'enforce_first_of_month_for_subsequent_periods',
    ]

    const { rows } = await getPool().query<{ proname: string; proconfig: string[] | null }>(
      `
      SELECT p.proname, p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
    `,
      [targets],
    )

    expect(rows.length).toBeGreaterThan(0)

    const unpinned = rows
      .filter((row) => !(row.proconfig ?? []).some((entry) => entry.startsWith('search_path=')))
      .map((row) => row.proname)

    // An unpinned SECURITY DEFINER trigger on the journal is an object-shadowing
    // candidate on exactly the functions that enforce immutability and voucher
    // numbering.
    expect(unpinned).toEqual([])
  })
})
