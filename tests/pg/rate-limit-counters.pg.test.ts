import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient } from '@/tests/pg/setup'

/**
 * consume_rate_limit() is what makes the BankID start limit real in a
 * deployment without Upstash. The properties that matter are: it counts, it
 * refuses past the limit, a refused request does not extend the window, the
 * window restarts once it has passed, and buckets/identifiers never bleed into
 * each other.
 */
async function consume(
  client: Awaited<ReturnType<typeof getClient>>,
  bucket: string,
  identifier: string,
  max = 2,
  windowSeconds = 60,
) {
  const { rows } = await client.query(
    'SELECT public.consume_rate_limit($1, $2, $3, $4) AS result',
    [bucket, identifier, max, windowSeconds],
  )
  return rows[0].result as {
    allowed: boolean
    limit: number
    remaining: number
    reset_at: string
  }
}

describe('consume_rate_limit (pg-real)', () => {
  it('allows up to the limit and then refuses', async () => {
    const client = await getClient()
    const bucket = `test:${randomUUID()}`
    try {
      const first = await consume(client, bucket, 'ip-a')
      expect(first.allowed).toBe(true)
      expect(first.remaining).toBe(1)

      const second = await consume(client, bucket, 'ip-a')
      expect(second.allowed).toBe(true)
      expect(second.remaining).toBe(0)

      const third = await consume(client, bucket, 'ip-a')
      expect(third.allowed).toBe(false)
      expect(third.remaining).toBe(0)
      expect(third.limit).toBe(2)
    } finally {
      client.release()
    }
  })

  it('does not let a refused request push the window forward', async () => {
    const client = await getClient()
    const bucket = `test:${randomUUID()}`
    try {
      await consume(client, bucket, 'ip-a', 1)
      const refused = await consume(client, bucket, 'ip-a', 1)
      expect(refused.allowed).toBe(false)

      // Hammering a closed window must neither raise the stored count nor move
      // reset_at — otherwise a client retrying in a loop locks itself out
      // forever.
      const again = await consume(client, bucket, 'ip-a', 1)
      expect(again.reset_at).toBe(refused.reset_at)

      const { rows } = await client.query(
        'SELECT request_count FROM public.rate_limit_counters WHERE bucket = $1 AND identifier = $2',
        [bucket, 'ip-a'],
      )
      // Saturated one past the limit and stays there, however many times the
      // caller retries.
      expect(rows[0].request_count).toBe(2)
    } finally {
      client.release()
    }
  })

  it('starts a fresh window once the old one has passed', async () => {
    const client = await getClient()
    const bucket = `test:${randomUUID()}`
    try {
      const first = await consume(client, bucket, 'ip-a', 1, 1)
      expect(first.allowed).toBe(true)
      expect((await consume(client, bucket, 'ip-a', 1, 1)).allowed).toBe(false)

      // Expire the window in place rather than sleeping — the function keys off
      // window_end, so backdating it is exactly what the passage of time does.
      await client.query(
        `UPDATE public.rate_limit_counters
            SET window_end = now() - interval '1 second'
          WHERE bucket = $1 AND identifier = $2`,
        [bucket, 'ip-a'],
      )

      const afterReset = await consume(client, bucket, 'ip-a', 1, 1)
      expect(afterReset.allowed).toBe(true)
      expect(afterReset.remaining).toBe(0)
    } finally {
      client.release()
    }
  })

  it('keeps identifiers and buckets separate', async () => {
    const client = await getClient()
    const bucketA = `test:${randomUUID()}`
    const bucketB = `test:${randomUUID()}`
    try {
      await consume(client, bucketA, 'ip-a', 1)
      expect((await consume(client, bucketA, 'ip-a', 1)).allowed).toBe(false)
      expect((await consume(client, bucketA, 'ip-b', 1)).allowed).toBe(true)
      expect((await consume(client, bucketB, 'ip-a', 1)).allowed).toBe(true)
    } finally {
      client.release()
    }
  })

  it('rejects nonsense arguments instead of silently allowing', async () => {
    const client = await getClient()
    try {
      await expect(consume(client, '', 'ip-a')).rejects.toThrow(/bucket is required/)
      await expect(consume(client, 'test:args', '  ')).rejects.toThrow(/identifier is required/)
      await expect(consume(client, 'test:args', 'ip-a', 0)).rejects.toThrow(/max_requests/)
      await expect(consume(client, 'test:args', 'ip-a', 1, 0)).rejects.toThrow(/window_seconds/)
    } finally {
      client.release()
    }
  })

  it('is not reachable by anon or authenticated', async () => {
    const client = await getClient()
    try {
      for (const role of ['anon', 'authenticated']) {
        const { rows } = await client.query(
          `SELECT has_function_privilege($1, 'public.consume_rate_limit(text,text,integer,integer)', 'EXECUTE') AS can_exec`,
          [role],
        )
        expect(rows[0].can_exec).toBe(false)
      }

      // The table itself carries RLS with zero policies AND no grants; either
      // alone would be enough, both is the point.
      const { rows: tableRows } = await client.query(
        `SELECT relrowsecurity,
                (SELECT count(*) FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'rate_limit_counters') AS policy_count,
                has_table_privilege('anon', 'public.rate_limit_counters', 'SELECT') AS anon_select
           FROM pg_class WHERE oid = 'public.rate_limit_counters'::regclass`,
      )
      expect(tableRows[0].relrowsecurity).toBe(true)
      expect(Number(tableRows[0].policy_count)).toBe(0)
      expect(tableRows[0].anon_select).toBe(false)
    } finally {
      client.release()
    }
  })
})
