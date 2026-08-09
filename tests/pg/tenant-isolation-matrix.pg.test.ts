import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompanyMember, seedCompany } from './fixtures'

/**
 * Tenant isolation across the economically significant tables.
 *
 * Two layers, because they fail differently.
 *
 * The STRUCTURAL layer asks whether every company-scoped table is even wired
 * up: RLS enabled, and either a policy that scopes it or an explicit place on
 * the deny-all list. That is what catches a NEW table shipped without a policy,
 * which is the way a leak normally arrives — nobody writes a bad policy, they
 * forget to write one.
 *
 * The BEHAVIOURAL layer seeds real rows and asks the three questions that
 * matter for each of the tables named in the remediation brief: can the owner
 * read their own row, can a viewer of the same company read but not write, and
 * can a member of a different company see anything at all.
 */

/**
 * Company-scoped tables that intentionally have RLS with NO policy, which is
 * deny-all for every tenant role. These hold cross-tenant machinery that only
 * service_role may touch; giving them policies would weaken them.
 */
const DENY_ALL_TABLES = new Set([
  'company_registry_sync_events',
  'financial_operation_idempotency',
  'financial_outbox_events',
  'financial_repair_runs',
  'skatteverket_tokens',
  'stripe_one_time_event_applications',
  'stripe_one_time_refunds',
])

describe('every company-scoped table is wired for isolation', () => {
  it('enables RLS on every table carrying company_id', async () => {
    const { rows } = await getPool().query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public' AND col.table_name = c.relname
            AND col.column_name = 'company_id'
        )
      ORDER BY c.relname
    `)
    expect(
      rows.map((row) => row.relname),
      'A table with company_id and no RLS is readable across tenants.',
    ).toEqual([])
  })

  it('gives every company-scoped table either a policy or a deny-all decision', async () => {
    const { rows } = await getPool().query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public' AND col.table_name = c.relname
            AND col.column_name = 'company_id'
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = c.relname
        )
      ORDER BY c.relname
    `)
    const unexplained = rows
      .map((row) => row.relname)
      .filter((name) => !DENY_ALL_TABLES.has(name))

    expect(
      unexplained,
      'These tables have RLS on but no policy, so they are deny-all. If that is '
      + 'intended, add them to DENY_ALL_TABLES; if not, they are invisible to '
      + 'their own tenant and the feature is broken.',
    ).toEqual([])
  })

  it('keeps the deny-all tables genuinely unreadable by a member', async () => {
    // RLS-with-no-policy only denies if nothing else grants a bypass. Prove it
    // rather than trusting the shape.
    const seed = await seedCompany()
    for (const table of DENY_ALL_TABLES) {
      const visible = await withUserContext(seed.userId, async (client) => {
        try {
          const { rows } = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM public.${table}`,
          )
          return Number(rows[0].count)
        } catch {
          // No table grant at all is a stronger denial than an empty RLS
          // result, and several of these tables are locked down that way.
          return 0
        }
      })
      expect(visible, `${table} is readable by a tenant member`).toBe(0)
    }
  })

  it('requires write capability, not mere membership, on every write policy', async () => {
    // `company_id IN (SELECT user_company_ids())` answers "is this user a
    // MEMBER", which is true for a viewer. Used on an INSERT/UPDATE/DELETE
    // policy it lets a read-only user write. 57 tables were on that form —
    // supplier invoices, payments, salary runs, the chart of accounts — and
    // Supabase publishes PostgREST with the user's own JWT, so RLS is the only
    // thing standing between a viewer and a direct PATCH.
    //
    // Exactly one shape is allowed to keep membership as its company predicate:
    // a personal row the user owns, where the policy ALSO pins
    // `user_id = auth.uid()`. A viewer must be able to talk to the assistant,
    // and that write is not a write to the company's books. Membership alone is
    // still forbidden there — the ownership clause is what makes it safe, and
    // it is tighter than the write-capability version, which let any writer
    // edit any other member's conversation.
    const { rows } = await getPool().query<{
      tablename: string
      cmd: string
      owner_scoped: boolean
    }>(`
      SELECT
        tablename,
        cmd,
        (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%user_id = auth.uid()%' AS owner_scoped
      FROM pg_policies
      WHERE schemaname = 'public' AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
        AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%user_company_ids() AS user_company_ids%'
        AND (coalesce(qual, '') || coalesce(with_check, '')) NOT LIKE '%user_can_write_company%'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND c.table_name = pg_policies.tablename
            AND c.column_name = 'company_id'
        )
      ORDER BY tablename, cmd
    `)

    expect(
      rows.filter((row) => !row.owner_scoped).map((row) => `${row.tablename}.${row.cmd}`),
      'These write policies authorize on read-level membership, so a viewer can '
      + 'write. Use user_can_write_company(company_id) instead — or, for a row the '
      + 'user owns, add user_id = auth.uid() alongside the membership check.',
    ).toEqual([])

    // And the owner-scoped exemption is not open-ended: it covers the personal
    // assistant tables and nothing else. A new table appearing here means
    // someone reached for the carve-out; that should be a decision, not a
    // side effect.
    const OWNER_SCOPED_TABLES = ['agent_conversations', 'chat_messages', 'chat_sessions']
    expect(
      [...new Set(rows.filter((row) => row.owner_scoped).map((row) => row.tablename))].sort(),
    ).toEqual(OWNER_SCOPED_TABLES)
  })
})

/** Seeds one row per economically significant table for a company. */
async function seedBusinessData(seed: {
  userId: string
  companyId: string
  fiscalPeriodId: string
}) {
  const ids: Record<string, string> = {}

  ids.customer = randomUUID()
  await getPool().query(
    `INSERT INTO public.customers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Kund')`,
    [ids.customer, seed.userId, seed.companyId],
  )
  ids.invoice = randomUUID()
  await getPool().query(
    `INSERT INTO public.invoices
       (id, user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
        status, currency, total, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, '2026-01-01', '2026-02-01', 'sent', 'SEK', 1000, 0, 1000)`,
    [ids.invoice, seed.userId, seed.companyId, ids.customer, `INV-${randomUUID().slice(0, 8)}`],
  )
  ids.supplier = randomUUID()
  await getPool().query(
    `INSERT INTO public.suppliers (id, user_id, company_id, name) VALUES ($1, $2, $3, 'Lev')`,
    [ids.supplier, seed.userId, seed.companyId],
  )
  ids.supplierInvoice = randomUUID()
  await getPool().query(
    `INSERT INTO public.supplier_invoices
       (id, user_id, company_id, supplier_id, supplier_invoice_number, arrival_number,
        invoice_date, due_date, status, currency, total, paid_amount, remaining_amount)
     VALUES ($1, $2, $3, $4, $5, $6, '2026-01-01', '2026-02-01', 'approved', 'SEK', 500, 0, 500)`,
    [ids.supplierInvoice, seed.userId, seed.companyId, ids.supplier,
      `LF-${randomUUID().slice(0, 8)}`, Math.floor(Math.random() * 100_000_000)],
  )
  ids.transaction = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, user_id, company_id, date, description, amount, currency)
     VALUES ($1, $2, $3, '2026-01-15', 'Bank', -500, 'SEK')`,
    [ids.transaction, seed.userId, seed.companyId],
  )
  ids.journalEntry = randomUUID()
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', '2026-01-15', 'V', 'manual', 'draft')`,
    [ids.journalEntry, seed.userId, seed.companyId, seed.fiscalPeriodId],
  )
  ids.sieImport = randomUUID()
  await getPool().query(
    `INSERT INTO public.sie_imports
       (id, user_id, company_id, filename, file_hash, sie_type, status,
        total_vouchers, posted_vouchers, skipped_duplicate_vouchers, failed_vouchers)
     VALUES ($1, $2, $3, 'b.se', $4, '4', 'pending', 0, 0, 0, 0)`,
    [ids.sieImport, seed.userId, seed.companyId, `hash-${randomUUID()}`],
  )
  const { rows: products } = await getPool().query<{ id: string }>(
    `SELECT pr.id FROM public.platform_products pr
     JOIN public.platform_price_plans pp ON pp.product_id = pr.id
     WHERE pp.code = 'year_end_one_time' LIMIT 1`,
  )
  ids.purchase = randomUUID()
  await getPool().query(
    `INSERT INTO public.one_time_purchases
       (id, company_id, product_id, purchase_type, status, fiscal_period_id,
        permanent_access, access_starts_at, paid_at, created_by)
     VALUES ($1, $2, $3, 'year_end', 'active', $4, true, now(), now(), $5)`,
    [ids.purchase, seed.companyId, products[0].id, seed.fiscalPeriodId, seed.userId],
  )
  ids.fiscalPeriod = seed.fiscalPeriodId
  return ids
}

/** table -> the id key seeded above, for the read matrix. */
const READ_MATRIX: Array<{ table: string; key: string }> = [
  { table: 'invoices', key: 'invoice' },
  { table: 'customers', key: 'customer' },
  { table: 'suppliers', key: 'supplier' },
  { table: 'supplier_invoices', key: 'supplierInvoice' },
  { table: 'transactions', key: 'transaction' },
  { table: 'journal_entries', key: 'journalEntry' },
  { table: 'sie_imports', key: 'sieImport' },
  { table: 'fiscal_periods', key: 'fiscalPeriod' },
  { table: 'one_time_purchases', key: 'purchase' },
]

async function canRead(userId: string, table: string, id: string): Promise<boolean> {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query(`SELECT 1 FROM public.${table} WHERE id = $1`, [id])
    return rows.length > 0
  })
}

describe('tenant isolation matrix — reads', () => {
  it('shows a company its own rows and hides them from everyone else', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const ids = await seedBusinessData(a)

    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: viewerId, role: 'viewer' })

    for (const { table, key } of READ_MATRIX) {
      const id = ids[key]
      expect(await canRead(a.userId, table, id), `${table}: owner A cannot read own row`).toBe(true)
      expect(await canRead(viewerId, table, id), `${table}: viewer A cannot read own row`).toBe(true)
      expect(await canRead(b.userId, table, id), `${table}: user B CAN read company A's row`).toBe(false)
    }
  })
})

describe('tenant isolation matrix — writes', () => {
  it('refuses every write a viewer attempts on their own company', async () => {
    const a = await seedCompany()
    const ids = await seedBusinessData(a)
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: a.companyId, userId: viewerId, role: 'viewer' })

    const writes: Array<{ label: string; sql: string; params: unknown[] }> = [
      {
        label: 'insert invoice',
        sql: `INSERT INTO public.invoices
                (user_id, company_id, customer_id, invoice_number, invoice_date, due_date,
                 status, currency, total, paid_amount, remaining_amount)
              VALUES ($1, $2, $3, 'X-1', '2026-01-01', '2026-02-01', 'draft', 'SEK', 1, 0, 1)`,
        params: [viewerId, a.companyId, ids.customer],
      },
      { label: 'update invoice', sql: `UPDATE public.invoices SET notes = 'x' WHERE id = $1`, params: [ids.invoice] },
      { label: 'delete invoice', sql: `DELETE FROM public.invoices WHERE id = $1`, params: [ids.invoice] },
      { label: 'update supplier invoice', sql: `UPDATE public.supplier_invoices SET notes = 'x' WHERE id = $1`, params: [ids.supplierInvoice] },
      { label: 'update transaction', sql: `UPDATE public.transactions SET description = 'x' WHERE id = $1`, params: [ids.transaction] },
      { label: 'update journal entry', sql: `UPDATE public.journal_entries SET description = 'x' WHERE id = $1`, params: [ids.journalEntry] },
    ]

    for (const write of writes) {
      const outcome = await withUserContext(viewerId, async (client) => {
        try {
          const result = await client.query(write.sql, write.params)
          return { blocked: false, rowCount: result.rowCount ?? 0 }
        } catch {
          return { blocked: true, rowCount: 0 }
        }
      })
      // Either the statement errors, or RLS makes it affect zero rows. Both are
      // a refusal; silently changing a row is not.
      expect(
        outcome.blocked || outcome.rowCount === 0,
        `viewer was able to ${write.label}`,
      ).toBe(true)
    }
  })

  it('refuses every cross-company write an owner of another company attempts', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const ids = await seedBusinessData(a)

    const writes: Array<{ label: string; sql: string; params: unknown[] }> = [
      { label: 'update invoice', sql: `UPDATE public.invoices SET notes = 'x' WHERE id = $1`, params: [ids.invoice] },
      { label: 'delete invoice', sql: `DELETE FROM public.invoices WHERE id = $1`, params: [ids.invoice] },
      { label: 'update journal entry', sql: `UPDATE public.journal_entries SET description = 'x' WHERE id = $1`, params: [ids.journalEntry] },
      { label: 'delete transaction', sql: `DELETE FROM public.transactions WHERE id = $1`, params: [ids.transaction] },
      { label: 'update supplier invoice', sql: `UPDATE public.supplier_invoices SET notes = 'x' WHERE id = $1`, params: [ids.supplierInvoice] },
      { label: 'update sie import', sql: `UPDATE public.sie_imports SET status = 'failed' WHERE id = $1`, params: [ids.sieImport] },
      { label: 'update purchase', sql: `UPDATE public.one_time_purchases SET status = 'cancelled' WHERE id = $1`, params: [ids.purchase] },
    ]

    for (const write of writes) {
      const outcome = await withUserContext(b.userId, async (client) => {
        try {
          const result = await client.query(write.sql, write.params)
          return { blocked: false, rowCount: result.rowCount ?? 0 }
        } catch {
          return { blocked: true, rowCount: 0 }
        }
      })
      expect(
        outcome.blocked || outcome.rowCount === 0,
        `company B was able to ${write.label} in company A`,
      ).toBe(true)
    }

    // And nothing actually changed.
    const { rows } = await getPool().query<{ notes: string | null; status: string }>(
      `SELECT notes, status FROM public.invoices WHERE id = $1`, [ids.invoice],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].notes).toBeNull()
    expect(rows[0].status).toBe('sent')
  })

  it('lets the owner do the writes the viewer and outsider could not', async () => {
    // Without this the refusals above could be produced by a broken policy that
    // denies everyone, which would look identical.
    const a = await seedCompany()
    const ids = await seedBusinessData(a)

    const rowCount = await withUserContext(a.userId, async (client) => {
      const result = await client.query(
        `UPDATE public.invoices SET notes = 'owner edit' WHERE id = $1`, [ids.invoice],
      )
      return result.rowCount ?? 0
    })
    expect(rowCount).toBe(1)
  })
})

describe('tenant isolation matrix — entitlements', () => {
  it('does not let one company consume another company entitlement', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    await seedBusinessData(a)

    // A bought year-end access for its own period. B must not inherit it.
    const { rows } = await getPool().query<{ allowed: boolean }>(
      `SELECT allowed FROM public.company_feature_access($1, 'year_end.projects')`,
      [b.companyId],
    )
    expect(rows[0]?.allowed ?? false).toBe(false)
  })

  it('binds the purchase to the period it was bought for', async () => {
    const a = await seedCompany()
    const ids = await seedBusinessData(a)

    const { rows } = await getPool().query<{ fiscal_period_id: string | null }>(
      `SELECT fiscal_period_id FROM public.one_time_purchases WHERE id = $1`,
      [ids.purchase],
    )
    expect(rows[0].fiscal_period_id).toBe(a.fiscalPeriodId)
  })
})
