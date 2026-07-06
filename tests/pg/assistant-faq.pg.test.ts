import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260707120000_assistant_faq_entries + the generated seed migrations
 * (…_seed_assistant_faq_entries.sql):
 *   - the seeded DB rows match data/assistant/faq-sv.json exactly (the
 *     dataset is the single source of truth; it grows append-only past the
 *     original 450-entry floor)
 *   - RLS: authenticated users can read, cannot write
 *   - search_assistant_faq RPC returns ranked hits for Swedish questions
 *   - assistant_faq_status RPC reports count + seed time
 */

const dataset = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../data/assistant/faq-sv.json'), 'utf8'),
) as Array<{ id: string; category: string }>

const EXPECTED_DISTRIBUTION: Record<string, number> = {}
for (const entry of dataset) {
  EXPECTED_DISTRIBUTION[entry.category] = (EXPECTED_DISTRIBUTION[entry.category] ?? 0) + 1
}

describe('assistant_faq_entries.pg — seed, RLS and search RPC', () => {
  it('seed migrations populated the DB to match the dataset exactly', async () => {
    const res = await getPool().query<{ category: string; n: number }>(
      `SELECT category, count(*)::int AS n
         FROM public.assistant_faq_entries
        GROUP BY category`,
    )
    const counts = Object.fromEntries(res.rows.map((r) => [r.category, r.n]))
    let total = 0
    for (const [category, expected] of Object.entries(EXPECTED_DISTRIBUTION)) {
      expect(counts[category], category).toBe(expected)
      total += expected
    }
    // Append-only floor: the original curated dataset had 450 entries.
    expect(total).toBeGreaterThanOrEqual(450)
    expect(total).toBe(dataset.length)
    expect(res.rows.length).toBe(Object.keys(EXPECTED_DISTRIBUTION).length)
  })

  it('authenticated users can read entries via RLS', async () => {
    const { userId } = await seedCompany()
    const rows = await withUserContext(userId, async (client) => {
      const res = await client.query<{ id: string; answer_sv: string }>(
        `SELECT id, answer_sv FROM public.assistant_faq_entries LIMIT 5`,
      )
      return res.rows
    })
    expect(rows.length).toBe(5)
    for (const r of rows) expect(r.answer_sv.length).toBeGreaterThan(0)
  })

  it('authenticated users cannot insert or update entries (RLS write denied)', async () => {
    const { userId } = await seedCompany()
    // Separate user contexts: the rejected INSERT aborts its transaction, so
    // the UPDATE probe must run in a fresh one.
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.assistant_faq_entries
             (id, category, intent, user_questions, short_answer_sv, answer_sv, risk_level, updated_at)
           VALUES ('hack-001', 'Felsökning & vanliga fel', 'hack',
                   '["a?","b?","c?"]'::jsonb, 'x', 'y', 'low', now())`,
        ),
      ).rejects.toThrow(/row-level security/i)
    })

    await withUserContext(userId, async (client) => {
      const upd = await client.query(
        `UPDATE public.assistant_faq_entries SET short_answer_sv = 'pwned' WHERE id = 'bank-001'`,
      )
      // UPDATE without a policy silently affects zero rows.
      expect(upd.rowCount).toBe(0)
    })
  })

  it('search_assistant_faq returns ranked hits for a Swedish question', async () => {
    const { userId } = await seedCompany()
    const rows = await withUserContext(userId, async (client) => {
      const res = await client.query<{ id: string; rank: number; risk_level: string }>(
        `SELECT id, rank, risk_level FROM public.search_assistant_faq('hur kopplar jag banken', 5)`,
      )
      return res.rows
    })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.id === 'bank-001')).toBe(true)
    // Ranked descending.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].rank).toBeLessThanOrEqual(rows[i - 1].rank)
    }
  })

  it('search_assistant_faq handles free-form text without tsquery syntax errors', async () => {
    const { userId } = await seedCompany()
    const rows = await withUserContext(userId, async (client) => {
      const res = await client.query(
        `SELECT id FROM public.search_assistant_faq('kunden betalade för mycket — vad gör jag?!', 5)`,
      )
      return res.rows
    })
    // Must not throw; hits are expected for this phrasing.
    expect(Array.isArray(rows)).toBe(true)
  })

  it('assistant_faq_status reports the seeded count and timestamps', async () => {
    const { userId } = await seedCompany()
    const row = await withUserContext(userId, async (client) => {
      const res = await client.query<{
        entry_count: string
        last_seeded_at: string
        last_updated_at: string
      }>(`SELECT * FROM public.assistant_faq_status()`)
      return res.rows[0]
    })
    expect(Number(row.entry_count)).toBe(dataset.length)
    expect(row.last_seeded_at).toBeTruthy()
    expect(row.last_updated_at).toBeTruthy()
  })
})
