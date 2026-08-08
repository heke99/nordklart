import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool, openUserTx, withUserContext } from '@/tests/pg/setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertCompanySettings,
  insertFiscalPeriod,
  satisfyManualCashReconciliation,
} from '@/tests/pg/fixtures'

/**
 * Year-end close: the access and tenancy dimensions of the user journey.
 *
 * year-end-atomic-close.pg.test.ts already covers the economics — atomicity,
 * replay, concurrency, readiness, continuity. What it does not cover is WHO may
 * close WHICH period, and that is the axis a viewer-finalization bypass slipped
 * through on once already (R-01: a company-wide iXBRL entitlement short-circuited
 * the actor/period check, so a viewer could lock an annual report).
 *
 * Everything here therefore drives the close as a real authenticated user
 * rather than as service_role, because the checks under test only exist on the
 * authenticated path.
 */

async function seedClosableCompany(options: { entitled?: boolean } = {}) {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await insertCompanySettings({ companyId })
  const fiscalPeriodId = await insertFiscalPeriod({
    userId,
    companyId,
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    name: '2025',
  })

  if (options.entitled !== false) {
    const { rows: products } = await getPool().query<{ id: string }>(
      `SELECT pr.id FROM public.platform_products pr
       JOIN public.platform_price_plans pp ON pp.product_id = pr.id
       WHERE pp.code = 'year_end_one_time' LIMIT 1`,
    )
    await getPool().query(
      `INSERT INTO public.one_time_purchases
         (company_id, product_id, purchase_type, status, fiscal_period_id,
          permanent_access, access_starts_at, paid_at, created_by)
       VALUES ($1, $2, 'year_end', 'active', $3, true, now(), now(), $4)`,
      [companyId, products[0].id, fiscalPeriodId, userId],
    )
  }
  return { userId, companyId, fiscalPeriodId }
}

async function postActivity(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  amount?: number
}): Promise<void> {
  const entryId = randomUUID()
  const amount = params.amount ?? 1000
  await getPool().query(
    `INSERT INTO public.journal_entries
       (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
        entry_date, description, source_type, status)
     VALUES ($1, $2, $3, $4, 0, 'A', '2025-06-01', 'Sale', 'manual', 'draft')`,
    [entryId, params.userId, params.companyId, params.fiscalPeriodId],
  )
  await getPool().query(
    `INSERT INTO public.journal_entry_lines
       (journal_entry_id, account_number, debit_amount, credit_amount)
     VALUES ($1, '1930', $2, 0), ($1, '3001', 0, $2)`,
    [entryId, amount],
  )
  await getPool().query(
    `SELECT * FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
    [params.companyId, entryId],
  )
}

/** Raised message, which is the year-end contract's stable identifier here. */
function yearEndError(error: unknown): string {
  const value = error as { message?: string } | null
  return value?.message ?? ''
}

async function createPreviewAs(
  userId: string,
  companyId: string,
  fiscalPeriodId: string,
): Promise<string> {
  const tx = await openUserTx(userId)
  try {
    const { rows } = await tx.client.query<{ result: { preview_id: string } }>(
      `SELECT public.create_year_end_preview($1::uuid, $2::uuid, $3::uuid, '{}'::jsonb) AS result`,
      [companyId, fiscalPeriodId, userId],
    )
    await tx.commit()
    return rows[0].result.preview_id
  } finally {
    await tx.rollback()
  }
}

async function executeAs(params: {
  actorId: string
  companyId: string
  fiscalPeriodId: string
  previewId: string
  idempotencyKey?: string
  declaredUserId?: string
}): Promise<Record<string, unknown>> {
  const tx = await openUserTx(params.actorId)
  try {
    const { rows } = await tx.client.query<{ result: Record<string, unknown> }>(
      `SELECT public.execute_year_end_closing(
         $1::uuid, $2::uuid, $3::uuid, $4, NULL, $5::uuid
       ) AS result`,
      [
        params.companyId,
        params.fiscalPeriodId,
        params.declaredUserId ?? params.actorId,
        params.idempotencyKey ?? `ye-${randomUUID()}`,
        params.previewId,
      ],
    )
    await tx.commit()
    return rows[0].result
  } finally {
    await tx.rollback()
  }
}

/** Full happy-path close as an authenticated owner. */
async function closeAsOwner(seed: {
  userId: string
  companyId: string
  fiscalPeriodId: string
}) {
  await postActivity(seed)
  await satisfyManualCashReconciliation({
    companyId: seed.companyId,
    fiscalPeriodId: seed.fiscalPeriodId,
    userId: seed.userId,
  })
  const previewId = await createPreviewAs(seed.userId, seed.companyId, seed.fiscalPeriodId)
  return executeAs({
    actorId: seed.userId,
    companyId: seed.companyId,
    fiscalPeriodId: seed.fiscalPeriodId,
    previewId,
  })
}

describe('year-end journey — the happy path an owner walks', () => {
  it('closes a company that reconciles cash manually', async () => {
    const seed = await seedClosableCompany()
    const result = await closeAsOwner(seed)

    expect(result.closing_entry_id).toBeTruthy()
    expect(result.opening_balance_entry_id).toBeTruthy()
    expect(result.next_period_id).toBeTruthy()

    const { rows } = await getPool().query<{ is_closed: boolean; locked_at: string | null }>(
      `SELECT is_closed, locked_at::text FROM public.fiscal_periods WHERE id = $1`,
      [seed.fiscalPeriodId],
    )
    expect(rows[0].is_closed).toBe(true)
    expect(rows[0].locked_at).not.toBeNull()
  })

  it('replays the same close request with the canonical result', async () => {
    const seed = await seedClosableCompany()
    await postActivity(seed)
    await satisfyManualCashReconciliation({
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
      userId: seed.userId,
    })
    const previewId = await createPreviewAs(seed.userId, seed.companyId, seed.fiscalPeriodId)
    const key = `ye-${randomUUID()}`

    const first = await executeAs({
      actorId: seed.userId,
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
      previewId,
      idempotencyKey: key,
    })
    const replay = await executeAs({
      actorId: seed.userId,
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
      previewId,
      idempotencyKey: key,
    })

    expect(replay.closing_entry_id).toBe(first.closing_entry_id)
    expect(replay.opening_balance_entry_id).toBe(first.opening_balance_entry_id)
    expect(replay.idempotent).toBe(true)

    // Exactly one closing entry regardless of how many times it was asked for.
    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries
       WHERE company_id = $1 AND fiscal_period_id = $2
         AND source_type = 'year_end_closing' AND status = 'posted'`,
      [seed.companyId, seed.fiscalPeriodId],
    )
    expect(rows[0].count).toBe('1')
  })

  it('refuses a second close of an already closed year', async () => {
    const seed = await seedClosableCompany()
    await closeAsOwner(seed)

    // A fresh preview against a closed year, then a fresh key: the year is
    // already closed and must say so rather than closing twice.
    let raised: unknown
    try {
      const previewId = await createPreviewAs(seed.userId, seed.companyId, seed.fiscalPeriodId)
      await executeAs({
        actorId: seed.userId,
        companyId: seed.companyId,
        fiscalPeriodId: seed.fiscalPeriodId,
        previewId,
      })
    } catch (error) {
      raised = error
    }
    expect(raised).toBeDefined()
    expect(yearEndError(raised)).toBe('YE_PERIOD_ALREADY_CLOSED')

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.journal_entries
       WHERE company_id = $1 AND fiscal_period_id = $2
         AND source_type = 'year_end_closing' AND status = 'posted'`,
      [seed.companyId, seed.fiscalPeriodId],
    )
    expect(rows[0].count).toBe('1')
  })
})

describe('year-end journey — blockers stop the close with a concrete reason', () => {
  it('refuses to close while cash is unreconciled and names the blocker', async () => {
    const seed = await seedClosableCompany()
    await postActivity(seed)
    // Deliberately skip satisfyManualCashReconciliation.

    const { rows } = await getPool().query<{ code: string }>(
      `SELECT code FROM public.year_end_db_blockers($1::uuid, $2::uuid)`,
      [seed.companyId, seed.fiscalPeriodId],
    )
    const codes = rows.map((row) => row.code)
    expect(codes.length).toBeGreaterThan(0)
    // A concrete, stable code — not a generic failure.
    expect(codes).toContain('manual_cash_reconciliation_missing')

    let raised: unknown
    try {
      const previewId = await createPreviewAs(seed.userId, seed.companyId, seed.fiscalPeriodId)
      await executeAs({
        actorId: seed.userId,
        companyId: seed.companyId,
        fiscalPeriodId: seed.fiscalPeriodId,
        previewId,
      })
    } catch (error) {
      raised = error
    }
    expect(raised).toBeDefined()

    const { rows: closed } = await getPool().query<{ is_closed: boolean }>(
      `SELECT is_closed FROM public.fiscal_periods WHERE id = $1`,
      [seed.fiscalPeriodId],
    )
    expect(closed[0].is_closed).toBe(false)
  })

  it('reports blockers without raising for a company that has none left', async () => {
    // The readiness call itself must be usable — a 404 or an exception here is
    // how "Kunde inte ladda …" screens happen.
    const seed = await seedClosableCompany()
    await postActivity(seed)
    await satisfyManualCashReconciliation({
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
      userId: seed.userId,
    })

    const { rows } = await getPool().query<{ code: string }>(
      `SELECT code FROM public.year_end_db_blockers($1::uuid, $2::uuid)`,
      [seed.companyId, seed.fiscalPeriodId],
    )
    expect(rows.map((row) => row.code)).not.toContain('manual_cash_reconciliation_missing')
  })

  it('names the period explicitly instead of reporting a clean bill of health', async () => {
    // A period that does not belong to the company must NOT come back as "no
    // blockers" — that would read as ready to close. It raises a stable,
    // specific code instead, which is what lets the UI say something true.
    const seed = await seedClosableCompany()
    const other = await seedClosableCompany()

    let raised: unknown
    try {
      await getPool().query(
        `SELECT code FROM public.year_end_db_blockers($1::uuid, $2::uuid)`,
        [seed.companyId, other.fiscalPeriodId],
      )
    } catch (error) {
      raised = error
    }
    expect(raised).toBeDefined()
    expect(yearEndError(raised)).toBe('YE_PERIOD_NOT_FOUND')
  })
})

describe('year-end journey — who may close', () => {
  it('refuses a viewer of the same company', async () => {
    // R-01 regression: a viewer must never be able to finalize, no matter what
    // company-wide entitlement exists.
    const seed = await seedClosableCompany()
    await postActivity(seed)
    await satisfyManualCashReconciliation({
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
      userId: seed.userId,
    })
    const previewId = await createPreviewAs(seed.userId, seed.companyId, seed.fiscalPeriodId)

    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: seed.companyId, userId: viewerId, role: 'viewer' })

    let raised: unknown
    try {
      await executeAs({
        actorId: viewerId,
        companyId: seed.companyId,
        fiscalPeriodId: seed.fiscalPeriodId,
        previewId,
      })
    } catch (error) {
      raised = error
    }
    expect(raised).toBeDefined()
    expect(yearEndError(raised)).toBe('YE_PERMISSION_DENIED')

    const { rows } = await getPool().query<{ is_closed: boolean }>(
      `SELECT is_closed FROM public.fiscal_periods WHERE id = $1`,
      [seed.fiscalPeriodId],
    )
    expect(rows[0].is_closed).toBe(false)
  })

  it('lets a viewer read the year without being able to close it', async () => {
    // The other half of the same contract: read access must survive.
    const seed = await seedClosableCompany()
    const viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId: seed.companyId, userId: viewerId, role: 'viewer' })

    const visible = await withUserContext(viewerId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM public.fiscal_periods WHERE id = $1`,
        [seed.fiscalPeriodId],
      )
      return rows.length
    })
    expect(visible).toBe(1)
  })

  it('refuses a user who is not a member of the company at all', async () => {
    const seed = await seedClosableCompany()
    const outsider = await seedClosableCompany()
    await postActivity(seed)
    await satisfyManualCashReconciliation({
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
      userId: seed.userId,
    })
    const previewId = await createPreviewAs(seed.userId, seed.companyId, seed.fiscalPeriodId)

    let raised: unknown
    try {
      await executeAs({
        actorId: outsider.userId,
        companyId: seed.companyId,
        fiscalPeriodId: seed.fiscalPeriodId,
        previewId,
      })
    } catch (error) {
      raised = error
    }
    expect(raised).toBeDefined()
    expect(yearEndError(raised)).toBe('YE_PERMISSION_DENIED')
  })

  it('refuses an owner who declares a different user as the actor', async () => {
    // The authenticated identity wins over the declared p_user_id, so a
    // legitimate caller cannot launder the close through someone else.
    const seed = await seedClosableCompany()
    const outsider = await seedClosableCompany()
    await postActivity(seed)
    await satisfyManualCashReconciliation({
      companyId: seed.companyId,
      fiscalPeriodId: seed.fiscalPeriodId,
      userId: seed.userId,
    })
    const previewId = await createPreviewAs(seed.userId, seed.companyId, seed.fiscalPeriodId)

    let raised: unknown
    try {
      await executeAs({
        actorId: outsider.userId,
        companyId: seed.companyId,
        fiscalPeriodId: seed.fiscalPeriodId,
        previewId,
        declaredUserId: seed.userId,
      })
    } catch (error) {
      raised = error
    }
    expect(raised).toBeDefined()
    // The outsider cannot even read company A, so the denial lands at the read
    // boundary before the year-end actor assertion is reached. Either way the
    // declared p_user_id never overrides the authenticated identity.
    expect(yearEndError(raised)).toContain('no read access to company')
  })
})

describe('year-end journey — which period may be closed', () => {
  it('refuses a preview that belongs to another company', async () => {
    const a = await seedClosableCompany()
    const b = await seedClosableCompany()
    await postActivity(b)
    await satisfyManualCashReconciliation({
      companyId: b.companyId,
      fiscalPeriodId: b.fiscalPeriodId,
      userId: b.userId,
    })
    const bPreview = await createPreviewAs(b.userId, b.companyId, b.fiscalPeriodId)

    let raised: unknown
    try {
      // A's owner, A's company, but B's preview id.
      await executeAs({
        actorId: a.userId,
        companyId: a.companyId,
        fiscalPeriodId: a.fiscalPeriodId,
        previewId: bPreview,
      })
    } catch (error) {
      raised = error
    }
    expect(raised).toBeDefined()
    // Scoped lookup: the preview is not merely stale, it is invisible from
    // company A, so it cannot be reached at all.
    expect(yearEndError(raised)).toBe('YE_PREVIEW_NOT_FOUND')

    const { rows } = await getPool().query<{ is_closed: boolean }>(
      `SELECT is_closed FROM public.fiscal_periods WHERE id = $1`,
      [b.fiscalPeriodId],
    )
    expect(rows[0].is_closed).toBe(false)
  })

  it('refuses a fiscal period that belongs to another company', async () => {
    const a = await seedClosableCompany()
    const b = await seedClosableCompany()
    await postActivity(a)
    await satisfyManualCashReconciliation({
      companyId: a.companyId,
      fiscalPeriodId: a.fiscalPeriodId,
      userId: a.userId,
    })
    const aPreview = await createPreviewAs(a.userId, a.companyId, a.fiscalPeriodId)

    let raised: unknown
    try {
      await executeAs({
        actorId: a.userId,
        companyId: a.companyId,
        fiscalPeriodId: b.fiscalPeriodId,
        previewId: aPreview,
      })
    } catch (error) {
      raised = error
    }
    expect(raised).toBeDefined()

    const { rows } = await getPool().query<{ is_closed: boolean }>(
      `SELECT is_closed FROM public.fiscal_periods WHERE id = $1`,
      [b.fiscalPeriodId],
    )
    expect(rows[0].is_closed).toBe(false)
  })

  it('refuses to create a preview for another company period', async () => {
    const a = await seedClosableCompany()
    const b = await seedClosableCompany()

    let raised: unknown
    try {
      await createPreviewAs(a.userId, b.companyId, b.fiscalPeriodId)
    } catch (error) {
      raised = error
    }
    expect(raised).toBeDefined()
    expect(yearEndError(raised)).toBe('YE_PERMISSION_DENIED')
  })
})
