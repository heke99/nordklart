import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, vi } from 'vitest'

vi.mock('server-only', () => ({}))

// Shared pool for the pg-real project. DATABASE_URL must point at a Postgres
// instance that already has every migration from supabase/migrations/ applied
// and that includes the Supabase `auth` schema (supabase/postgres image).
const databaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    // Concurrency tests hold two or three transactions open simultaneously and
    // still need a spare connection to observe lock waits from outside, so the
    // pool has to be comfortably larger than any single test's peak.
    pool = new Pool({ connectionString: databaseUrl, max: 16 })
  }
  return pool
}

// Acquire a fresh client. Caller must always .release().
export async function getClient(): Promise<PoolClient> {
  return getPool().connect()
}

// Run `fn` inside a role/JWT context that auth.uid() / user_company_ids() will
// observe. Uses SET LOCAL inside a transaction so the role reverts on commit
// or rollback. Always rolls back so the test's writes do not persist — tests
// that need to seed data must do that on the superuser connection first.
export async function withUserContext<T>(
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    // Set JWT claims BEFORE switching role: non-superuser set_config on a
    // namespaced GUC is fine, but keeping order explicit avoids surprises.
    // Set both the whole-claims object and the individual `sub` claim —
    // different versions of Supabase's auth.uid() read one or the other.
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query(`SET LOCAL ROLE authenticated`)
    // Fail loudly and early if the JWT context did not land the way we
    // expect — otherwise RLS policies return empty and the real test
    // failure points at an unrelated assertion.
    const authCheck = await client.query<{ uid: string | null }>(
      `SELECT auth.uid()::text AS uid`,
    )
    if (authCheck.rows[0]?.uid !== userId) {
      throw new Error(
        `withUserContext: auth.uid() resolved to ${authCheck.rows[0]?.uid ?? 'NULL'}, ` +
          `expected ${userId}. Check request.jwt.claims setup.`,
      )
    }
    const result = await fn(client)
    await client.query('ROLLBACK')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// Schema sanity: fail loud if migrations did not apply, rather than letting
// every test fail with a cryptic "relation does not exist". Runs once per
// test file (vitest invokes setupFiles per worker).
beforeAll(async () => {
  const client = await getClient()
  try {
    const result = await client.query<{ name: string; kind: 'trigger' | 'function' | 'table' }>(`
      SELECT 'trigger'::text AS kind, tgname AS name FROM pg_trigger
        WHERE tgname IN ('enforce_period_lock', 'audit_log_no_update')
      UNION ALL
      SELECT 'function'::text, proname FROM pg_proc
        WHERE proname IN ('commit_journal_entry', 'user_company_ids', 'audit_log_immutable')
      UNION ALL
      SELECT 'table'::text, tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN ('journal_entries', 'companies', 'company_members',
                            'fiscal_periods', 'audit_log', 'voucher_sequences')
    `)
    const found = new Set(result.rows.map((r) => `${r.kind}:${r.name}`))
    const required = [
      'trigger:enforce_period_lock',
      'trigger:audit_log_no_update',
      'function:commit_journal_entry',
      'function:user_company_ids',
      'function:audit_log_immutable',
      'table:journal_entries',
      'table:companies',
      'table:company_members',
      'table:fiscal_periods',
      'table:audit_log',
      'table:voucher_sequences',
    ]
    const missing = required.filter((r) => !found.has(r))
    if (missing.length > 0) {
      throw new Error(
        `pg-real schema sanity check failed. Missing: ${missing.join(', ')}. ` +
          `Did every migration in supabase/migrations/ apply cleanly to ${databaseUrl}?`,
      )
    }
  } finally {
    client.release()
  }
})

afterAll(async () => {
  if (pool) {
    await pool.end()
    pool = null
  }
})

/**
 * Runs `fn` with auth.role() = 'service_role' for the duration of one
 * transaction.
 *
 * The financial RPCs (settle_customer_invoice, settle_supplier_invoice,
 * record_year_end_manual_cash_reconciliation, …) call require_service_role(),
 * which reads the JWT claim rather than the PostgreSQL role — connecting as
 * superuser is not enough. The claim is set with `set_config(..., true)` so it
 * is transaction-local and cannot leak to the next user of the pooled
 * connection.
 */
export interface ServiceRoleTx {
  client: PoolClient
  commit: () => Promise<void>
  rollback: () => Promise<void>
}

/**
 * Opens a service-role transaction and hands back manual commit/rollback.
 *
 * withServiceRole() owns its transaction boundary, which makes it useless for
 * concurrency: proving that two settlements serialize correctly requires two
 * transactions open AT THE SAME TIME, with the test choosing when each one
 * commits. Every caller must commit or roll back — an abandoned transaction
 * holds its advisory locks until the pooled connection is reused and will hang
 * the next test instead of failing this one.
 */
export async function openServiceRoleTx(): Promise<ServiceRoleTx> {
  const client = await getClient()
  let settled = false
  const finish = async (verb: 'COMMIT' | 'ROLLBACK') => {
    if (settled) return
    settled = true
    try {
      await client.query(verb)
    } finally {
      client.release()
    }
  }
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
    await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    throw error
  }
  return {
    client,
    commit: () => finish('COMMIT'),
    rollback: () => finish('ROLLBACK'),
  }
}

/**
 * Same as openServiceRoleTx() but authenticated as `userId`.
 *
 * withUserContext() always rolls back, which is right for RLS assertions and
 * useless for concurrency: an RPC that authorizes through auth.uid() can only
 * be raced by two transactions that each choose when to commit.
 */
export async function openUserTx(userId: string): Promise<ServiceRoleTx> {
  const client = await getClient()
  let settled = false
  const finish = async (verb: 'COMMIT' | 'ROLLBACK') => {
    if (settled) return
    settled = true
    try {
      await client.query(verb)
    } finally {
      client.release()
    }
  }
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    const check = await client.query<{ uid: string | null }>(`SELECT auth.uid()::text AS uid`)
    if (check.rows[0]?.uid !== userId) {
      throw new Error(`openUserTx: auth.uid() resolved to ${check.rows[0]?.uid ?? 'NULL'}`)
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    throw error
  }
  return { client, commit: () => finish('COMMIT'), rollback: () => finish('ROLLBACK') }
}

/**
 * True once `pid` is waiting on a lock. Concurrency tests need to prove that
 * the second transaction actually BLOCKS rather than racing past — polling
 * pg_stat_activity is the only way to observe that from outside.
 */
export async function waitUntilBlocked(pid: number, timeoutMs = 5000): Promise<boolean> {
  const client = await getClient()
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { rows } = await client.query<{ blocked: boolean }>(
        `SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked`,
        [pid],
      )
      if (rows[0]?.blocked) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  } finally {
    client.release()
  }
}

export async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  return rows[0].pid
}

export async function withServiceRole<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
    await client.query(`SELECT set_config('request.jwt.claim.role', 'service_role', true)`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
