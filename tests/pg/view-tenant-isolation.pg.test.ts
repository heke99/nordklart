import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * Views must not become a way around RLS.
 *
 * A PostgreSQL view executes with the privileges of its OWNER unless it is
 * created with `security_invoker = true`. Four views here were owned by a
 * superuser, carried no tenant predicate of their own, and were granted SELECT
 * to `authenticated` — so the row-level security on the tables underneath was
 * never evaluated for the querying user. Measured before the fix, an ordinary
 * member of one company could read 388 foreign AR rows, 4 433 foreign usage
 * rows and 22 165 foreign limit rows.
 *
 * customer_ar_balances is the worst of them: customer ids and outstanding
 * receivables per company, which is every tenant's order book.
 *
 * Two guards, because either alone is escapable. The structural one catches a
 * NEW view added without security_invoker; the behavioural one proves the
 * setting actually isolates, since a view can carry the flag and still leak if
 * the table underneath has no policy.
 */

/** Views that may legitimately run with definer rights, and why. */
const DEFINER_ALLOWLIST = new Map<string, string>([
  ['public_price_plans_v', 'public price catalogue, deliberately readable by anon; no tenant data'],
  ['public_price_start_v', 'public price catalogue, deliberately readable by anon; no tenant data'],
  ['skatteverket_connections_v', 'filters company_id IN (SELECT user_company_ids()) in the view body'],
  ['bank_payment_allocation_discrepancies_v1', 'service_role only; no tenant role can select'],
  ['customer_subledger_discrepancies_v1', 'service_role only; no tenant role can select'],
  ['supplier_subledger_discrepancies_v1', 'service_role only; no tenant role can select'],
  ['cancelled_committed_journal_entry_inventory', 'service_role only; no tenant role can select'],
])

interface ViewRow {
  name: string
  invoker: boolean
  anon: boolean
  authenticated: boolean
}

async function publicViews(): Promise<ViewRow[]> {
  const { rows } = await getPool().query<ViewRow>(`
    SELECT c.relname AS name,
           COALESCE((
             SELECT option_value = 'true' FROM pg_options_to_table(c.reloptions)
             WHERE option_name = 'security_invoker'
           ), false) AS invoker,
           has_table_privilege('anon', c.oid, 'SELECT') AS anon,
           has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'v'
    ORDER BY c.relname
  `)
  return rows
}

describe('definer views are only allowed where they cannot leak', () => {
  it('has no unlisted view that runs with definer rights and is tenant-readable', async () => {
    const views = await publicViews()
    expect(views.length).toBeGreaterThan(5)

    const offenders = views
      .filter((view) => !view.invoker)
      .filter((view) => view.anon || view.authenticated)
      .filter((view) => !DEFINER_ALLOWLIST.has(view.name))
      .map((view) => view.name)

    expect(
      offenders,
      'These views bypass RLS for the querying user and are readable by a tenant '
      + 'role. Add `security_invoker = true`, or record why definer rights are safe '
      + 'in DEFINER_ALLOWLIST with the reason.',
    ).toEqual([])
  })

  it('keeps the four repaired views on invoker semantics', async () => {
    const views = new Map((await publicViews()).map((view) => [view.name, view]))
    for (const name of [
      'customer_ar_balances',
      'company_commercial_usage_v',
      'agency_commercial_usage_v',
      'company_effective_commercial_limits_v',
    ]) {
      expect(views.get(name)?.invoker, `${name} lost security_invoker`).toBe(true)
    }
  })

  it('does not expose an allowlisted service-role view to a tenant role', async () => {
    // The allowlist entries that claim "service_role only" must stay that way;
    // a later GRANT would silently turn a safe definer view into a leak.
    const views = new Map((await publicViews()).map((view) => [view.name, view]))
    for (const [name, reason] of DEFINER_ALLOWLIST) {
      if (!reason.includes('service_role only')) continue
      const view = views.get(name)
      if (!view) continue
      expect(view.anon, `${name} became anon-readable`).toBe(false)
      expect(view.authenticated, `${name} became authenticated-readable`).toBe(false)
    }
  })
})

describe('customer_ar_balances isolates tenants in practice', () => {
  it('shows a member their own receivables and nobody else', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    // An outstanding invoice in each company.
    for (const seed of [a, b]) {
      const customerId = randomUUID()
      await getPool().query(
        `INSERT INTO public.customers (id, user_id, company_id, name)
         VALUES ($1, $2, $3, 'Kund')`,
        [customerId, seed.userId, seed.companyId],
      )
      await getPool().query(
        `INSERT INTO public.invoices
           (user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
            status, currency, total, paid_amount, remaining_amount)
         VALUES ($1, $2, $3, $4, '2026-01-01', '2026-02-01', 'sent', 'SEK', 50000, 0, 50000)`,
        [seed.userId, seed.companyId, customerId, `INV-${randomUUID().slice(0, 8)}`],
      )
    }

    const seenByA = await withUserContext(a.userId, async (client) => {
      const { rows } = await client.query<{ company_id: string }>(
        `SELECT company_id FROM public.customer_ar_balances`,
      )
      return rows.map((row) => row.company_id)
    })

    // The point of the test: A sees its own row and zero foreign rows.
    expect(seenByA).toContain(a.companyId)
    expect(seenByA.filter((id) => id !== a.companyId)).toEqual([])
    expect(seenByA).not.toContain(b.companyId)
  })

  it('shows a non-member nothing at all', async () => {
    const a = await seedCompany()
    const outsider = await seedCompany()
    const customerId = randomUUID()
    await getPool().query(
      `INSERT INTO public.customers (id, user_id, company_id, name)
       VALUES ($1, $2, $3, 'Kund')`,
      [customerId, a.userId, a.companyId],
    )
    await getPool().query(
      `INSERT INTO public.invoices
         (user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
          status, currency, total, paid_amount, remaining_amount)
       VALUES ($1, $2, $3, $4, '2026-01-01', '2026-02-01', 'sent', 'SEK', 50000, 0, 50000)`,
      [a.userId, a.companyId, customerId, `INV-${randomUUID().slice(0, 8)}`],
    )

    const seen = await withUserContext(outsider.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT company_id FROM public.customer_ar_balances WHERE company_id = $1`,
        [a.companyId],
      )
      return rows.length
    })
    expect(seen).toBe(0)
  })
})

describe('commercial usage and limit views isolate tenants in practice', () => {
  it('scopes usage and limits to the caller company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()

    const result = await withUserContext(a.userId, async (client) => {
      const usage = await client.query<{ company_id: string }>(
        `SELECT company_id FROM public.company_commercial_usage_v`,
      )
      const limits = await client.query<{ company_id: string }>(
        `SELECT company_id FROM public.company_effective_commercial_limits_v`,
      )
      return {
        usage: usage.rows.map((row) => row.company_id),
        limits: limits.rows.map((row) => row.company_id),
      }
    })

    expect(result.usage.filter((id) => id !== a.companyId)).toEqual([])
    expect(result.limits.filter((id) => id !== a.companyId)).toEqual([])
    expect(result.usage).not.toContain(b.companyId)
    expect(result.limits).not.toContain(b.companyId)
  })
})
