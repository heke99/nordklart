import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'

async function setup() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

async function insertAttempt(params: {
  companyId: string
  userId: string
  idempotencyKey: string
  attempt: number
  status?: string
  nextRetryAt?: string | null
}) {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.skatteverket_api_requests
       (id, company_id, user_id, service, operation, auth_flow, correlation_id,
        method, status, idempotency_key, attempt_count, next_retry_at)
     VALUES ($1, $2, $3, 'momsdeklaration', 'moms.hamta', 'ccg_sysorg', $4,
             'GET', $5, $6, $7, $8)`,
    [
      id, params.companyId, params.userId, randomUUID(),
      params.status ?? 'started', params.idempotencyKey, params.attempt,
      params.nextRetryAt ?? null,
    ],
  )
  return id
}

describe('skatteverket_api_requests retry columns (pg-real)', () => {
  it('lets several attempts share one idempotency key', async () => {
    const { companyId, userId } = await setup()
    const key = `agi-${randomUUID()}`

    await insertAttempt({ companyId, userId, idempotencyKey: key, attempt: 1, status: 'failed' })
    await insertAttempt({ companyId, userId, idempotencyKey: key, attempt: 2, status: 'failed' })
    await insertAttempt({ companyId, userId, idempotencyKey: key, attempt: 3, status: 'succeeded' })

    const { rows } = await getPool().query(
      `SELECT attempt_count, status FROM public.skatteverket_api_requests
        WHERE idempotency_key = $1 ORDER BY attempt_count`,
      [key],
    )
    // Not unique on purpose: the key names the chain, it does not deduplicate
    // at Skatteverket — they have no idempotency header.
    expect(rows).toEqual([
      { attempt_count: 1, status: 'failed' },
      { attempt_count: 2, status: 'failed' },
      { attempt_count: 3, status: 'succeeded' },
    ])
  })

  it('defaults an attempt to 1 and refuses a lower one', async () => {
    const { companyId, userId } = await setup()
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.skatteverket_api_requests
         (id, company_id, user_id, service, operation, auth_flow, correlation_id, method, status)
       VALUES ($1, $2, $3, 'momsdeklaration', 'moms.hamta', 'ccg_sysorg', $4, 'GET', 'started')`,
      [id, companyId, userId, randomUUID()],
    )
    const { rows } = await getPool().query(
      'SELECT attempt_count FROM public.skatteverket_api_requests WHERE id = $1',
      [id],
    )
    expect(rows[0].attempt_count).toBe(1)

    await expect(
      insertAttempt({ companyId, userId, idempotencyKey: `k-${randomUUID()}`, attempt: 0 }),
    ).rejects.toThrow(/attempt_count_check/)
  })

  it('only lets a failed attempt carry a pending retry', async () => {
    const { companyId, userId } = await setup()
    const soon = new Date(Date.now() + 5_000).toISOString()

    // A started or succeeded attempt with a retry pending would mean the log
    // says two contradictory things about the same call.
    for (const status of ['started', 'succeeded']) {
      await expect(
        insertAttempt({
          companyId, userId, idempotencyKey: `k-${randomUUID()}`, attempt: 1,
          status, nextRetryAt: soon,
        }),
      ).rejects.toThrow(/retry_requires_failure/)
    }

    const id = await insertAttempt({
      companyId, userId, idempotencyKey: `k-${randomUUID()}`, attempt: 1,
      status: 'failed', nextRetryAt: soon,
    })
    const { rows } = await getPool().query(
      'SELECT next_retry_at FROM public.skatteverket_api_requests WHERE id = $1',
      [id],
    )
    expect(rows[0].next_retry_at).not.toBeNull()
  })

  it('refuses to leave a retry pending on a row that later succeeds', async () => {
    const { companyId, userId } = await setup()
    const id = await insertAttempt({
      companyId, userId, idempotencyKey: `k-${randomUUID()}`, attempt: 1,
      status: 'failed', nextRetryAt: new Date(Date.now() + 5_000).toISOString(),
    })

    await expect(
      getPool().query(
        `UPDATE public.skatteverket_api_requests SET status = 'succeeded' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/retry_requires_failure/)

    // Clearing the pending retry and closing the row together is the way out.
    await getPool().query(
      `UPDATE public.skatteverket_api_requests
          SET status = 'succeeded', next_retry_at = NULL WHERE id = $1`,
      [id],
    )
    const { rows } = await getPool().query(
      'SELECT status, next_retry_at FROM public.skatteverket_api_requests WHERE id = $1',
      [id],
    )
    expect(rows[0]).toEqual({ status: 'succeeded', next_retry_at: null })
  })

  it('finds due retries through the partial index', async () => {
    const { companyId, userId } = await setup()
    const key = `k-${randomUUID()}`
    await insertAttempt({
      companyId, userId, idempotencyKey: key, attempt: 1,
      status: 'failed', nextRetryAt: new Date(Date.now() - 1_000).toISOString(),
    })

    const { rows } = await getPool().query(
      `SELECT idempotency_key FROM public.skatteverket_api_requests
        WHERE next_retry_at IS NOT NULL AND next_retry_at <= now() AND idempotency_key = $1`,
      [key],
    )
    expect(rows).toHaveLength(1)
  })
})
