import { randomUUID } from 'node:crypto'
import { getPool } from './setup'

// Minimal fixture inserters for pg-real tests. All inserts go through the
// pool (superuser `postgres`), which bypasses RLS — that is intentional for
// seeding. RLS is exercised only where a test explicitly opens a user
// context via withUserContext().

export async function insertAuthUser(id: string = randomUUID()): Promise<string> {
  // auth.users has many columns but most default. We only need `id` and a
  // non-conflicting `email`. Everything else (role, aud, timestamps, etc.)
  // has a default or is nullable in the supabase/postgres image.
  await getPool().query(
    `INSERT INTO auth.users (id, email, instance_id)
     VALUES ($1, $2, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [id, `pg-real-${id}@test.invalid`],
  )
  return id
}

export async function insertCompany(params: {
  createdBy: string
  name?: string
  entityType?: 'enskild_firma' | 'aktiebolag'
  orgNumber?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.companies (id, name, entity_type, org_number, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      params.name ?? 'Test AB',
      params.entityType ?? 'aktiebolag',
      // An economic close requires canonical company facts (name, org number,
      // legal form, framework) — see year_end readiness `company_details_incomplete`.
      // Pass orgNumber: null explicitly to test the incomplete case.
      params.orgNumber === undefined ? '5560000001' : params.orgNumber,
      params.createdBy,
    ],
  )
  return id
}

/**
 * company_settings row with the canonical defaults. Year-end readiness requires
 * an explicit accounting_method, and the column already defaults to 'accrual',
 * so the row's existence is what matters. Idempotent: tests that insert their
 * own settings row still work.
 */
export async function insertCompanySettings(params: {
  companyId: string
  accountingMethod?: 'accrual' | 'cash'
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_settings (company_id, accounting_method)
     VALUES ($1, $2)
     ON CONFLICT (company_id) DO UPDATE SET accounting_method = EXCLUDED.accounting_method`,
    [params.companyId, params.accountingMethod ?? 'accrual'],
  )
}

export async function insertCompanyMember(params: {
  companyId: string
  userId: string
  role?: 'owner' | 'admin' | 'member' | 'viewer'
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.company_members (company_id, user_id, role)
     VALUES ($1, $2, $3)`,
    [params.companyId, params.userId, params.role ?? 'owner'],
  )
}

export async function insertFiscalPeriod(params: {
  userId: string
  companyId: string
  isClosed?: boolean
  periodStart?: string
  periodEnd?: string
  name?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.fiscal_periods
       (id, user_id, company_id, name, period_start, period_end, is_closed, closed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      params.userId,
      params.companyId,
      params.name ?? '2026',
      params.periodStart ?? '2026-01-01',
      params.periodEnd ?? '2026-12-31',
      params.isClosed ?? false,
      params.isClosed ? new Date() : null,
    ],
  )
  return id
}

// One-call helper: creates user + company + owner membership + open fiscal
// period. Returns the IDs tests need.
export async function seedCompany(overrides: { isClosed?: boolean } = {}): Promise<{
  userId: string
  companyId: string
  fiscalPeriodId: string
}> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertCompanySettings({ companyId })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    isClosed: overrides.isClosed,
  })
  return { userId, companyId, fiscalPeriodId }
}

// Insert a cash account (cash_accounts row). ledger_account is unique per
// company; is_primary defaults false to avoid the one-primary partial index.
export async function insertCashAccount(params: {
  companyId: string
  ledgerAccount: string
  currency?: string
  iban?: string | null
  externalUid?: string | null
  isPrimary?: boolean
  enabled?: boolean
  source?: 'enable_banking' | 'manual' | 'sie_import'
  bankConnectionId?: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.cash_accounts
       (id, company_id, ledger_account, currency, iban, external_uid,
        is_primary, enabled, source, bank_connection_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      params.companyId,
      params.ledgerAccount,
      params.currency ?? 'SEK',
      params.iban ?? null,
      params.externalUid ?? null,
      params.isPrimary ?? false,
      params.enabled ?? true,
      params.source ?? 'manual',
      params.bankConnectionId ?? null,
    ],
  )
  return id
}

// Insert a bank transaction row. cashAccountId/journalEntryId default null so
// tests can exercise the backfill and the NULL-fallback scoping.
export async function insertTransaction(params: {
  companyId: string
  userId: string
  currency?: string
  amount?: number
  date?: string
  description?: string
  externalId?: string | null
  journalEntryId?: string | null
  cashAccountId?: string | null
  isIgnored?: boolean
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.transactions
       (id, company_id, user_id, currency, amount, date, description,
        external_id, journal_entry_id, cash_account_id, is_ignored, category)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'uncategorized')`,
    [
      id,
      params.companyId,
      params.userId,
      params.currency ?? 'SEK',
      params.amount ?? -100,
      params.date ?? '2026-06-01',
      params.description ?? 'Test tx',
      params.externalId ?? null,
      params.journalEntryId ?? null,
      params.cashAccountId ?? null,
      params.isIgnored ?? false,
    ],
  )
  return id
}

// Insert a draft journal entry and return its id. Uses a placeholder
// voucher_number=0 which commit_journal_entry() will overwrite on commit.
// When status='posted', the deferred check_balance_on_posted_insert
// constraint trigger requires balanced non-zero lines at COMMIT, so the
// entry and a balanced line pair are inserted in ONE statement (= one
// implicit transaction on the pool).
export async function insertDraftJournalEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  entryDate?: string
  description?: string
  voucherSeries?: string
  status?: 'draft' | 'posted'
  voucherNumber?: number
}): Promise<string> {
  const id = randomUUID()
  const status = params.status ?? 'draft'
  const values = [
    id,
    params.userId,
    params.companyId,
    params.fiscalPeriodId,
    params.voucherNumber ?? 0,
    params.voucherSeries ?? 'A',
    params.entryDate ?? '2026-06-01',
    params.description ?? 'Test entry',
    status,
  ]
  if (status === 'posted') {
    await getPool().query(
      `WITH e AS (
         INSERT INTO public.journal_entries
           (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
            entry_date, description, source_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9)
         RETURNING id
       )
       INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount)
       SELECT id, '1930', 1000, 0 FROM e
       UNION ALL
       SELECT id, '3001', 0, 1000 FROM e`,
      values,
    )
  } else {
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9)`,
      values,
    )
  }
  return id
}

// Insert a balanced pair of journal entry lines (1 debit row + 1 credit row
// at the given amount). Needed before commit_journal_entry() because the
// balance constraint trigger fires on draft→posted.
export async function insertBalancedLines(
  journalEntryId: string,
  amount: number = 1000,
): Promise<void> {
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', $2, 0),
            ($1, '3001', 0, $2)`,
    [journalEntryId, amount],
  )
}

// ---------------------------------------------------------------------------
// Year-end manual cash reconciliation
// ---------------------------------------------------------------------------
// A company without a bank connection must verify each cash account's balance
// manually against an uploaded statement before the books can be closed
// (`manual_cash_reconciliation_missing`). Creating a company seeds a default
// cash account, so *every* year-end close test hits this gate.

/** WORM evidence document standing in for an uploaded bank statement. */
export async function insertEvidenceDocument(params: {
  userId: string
  companyId: string
  fileName?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.document_attachments
       (id, user_id, company_id, storage_path, file_name, file_size_bytes,
        mime_type, sha256_hash, uploaded_by, upload_source)
     VALUES ($1, $2, $3, $4, $5, 1024,
             'application/pdf', $6, $2, 'file_upload')`,
    [
      id,
      params.userId,
      params.companyId,
      `documents/${params.userId}/${id}.pdf`,
      params.fileName ?? 'kontoutdrag.pdf',
      randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    ],
  )
  return id
}

export async function recordManualCashReconciliation(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  /** Null when the company has no cash_accounts row for the ledger account. */
  cashAccountId: string | null
  statementBalance: number
  evidenceDocumentId: string
}): Promise<void> {
  await getPool().query(
    `SELECT public.record_year_end_manual_cash_reconciliation(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::uuid, $7
     )`,
    [
      params.companyId,
      params.fiscalPeriodId,
      params.userId,
      params.cashAccountId,
      params.statementBalance,
      params.evidenceDocumentId,
      `test-${randomUUID()}`,
    ],
  )
}

/**
 * Clears the manual-cash-reconciliation blocker for every cash account on the
 * company by attesting the statement balance at the account's actual posted
 * ledger balance, so the recorded difference is zero.
 *
 * Call this AFTER posting the entries a test needs, otherwise the snapshot goes
 * stale (`manual_cash_reconciliation_stale`) as soon as another line lands on
 * the account.
 */
export async function satisfyManualCashReconciliation(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
}): Promise<void> {
  // Drive off the status function, not cash_accounts: a company with no
  // cash_accounts row still gets a synthetic manual row for its ledger cash
  // account (e.g. 1930) with a NULL cash_account_id, and that row is what the
  // blocker iterates. It also hands back the server-computed ledger_balance,
  // so attesting to exactly that value yields a zero difference.
  const { rows: accounts } = await getPool().query<{
    cash_account_id: string | null
    ledger_balance: string
    reconciliation_mode: string
    is_reconciled: boolean
  }>(
    `SELECT cash_account_id, ledger_balance, reconciliation_mode, is_reconciled
     FROM public.year_end_cash_reconciliation_status($1::uuid, $2::uuid)`,
    [params.companyId, params.fiscalPeriodId],
  )

  const pending = accounts.filter(
    (account) => account.reconciliation_mode === 'manual' && !account.is_reconciled,
  )
  if (pending.length === 0) return

  const evidenceDocumentId = await insertEvidenceDocument(params)
  for (const account of pending) {
    await recordManualCashReconciliation({
      ...params,
      cashAccountId: account.cash_account_id,
      statementBalance: Number(account.ledger_balance ?? 0),
      evidenceDocumentId,
    })
  }
}
