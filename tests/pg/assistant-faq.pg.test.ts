import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * Covers 20260707120000_assistant_faq_entries + the generated seed migration
 * (…_seed_assistant_faq_entries.sql):
 *   - seed populated exactly 450 entries with the mandated category counts
 *   - RLS: authenticated users can read, cannot write
 *   - search_assistant_faq RPC returns ranked hits for Swedish questions
 *   - assistant_faq_status RPC reports count + seed time
 */

const EXPECTED_DISTRIBUTION: Record<string, number> = {
  'Kom igång & onboarding': 35,
  'Bankkoppling & transaktioner': 45,
  'Bokföring, verifikationer & BAS-konton': 55,
  'Moms, VAT & periodisk sammanställning': 55,
  'Fakturering, kundreskontra & Bankgiro': 45,
  'Leverantörsfakturor, kvitton & OCR': 35,
  'Lön, AGI & F-skatt': 40,
  'Bokslut, årsredovisning, INK2, NE & SRU': 55,
  'Import/export, SIE, API & webhooks': 35,
  'Byrå, plattform, behörigheter & säkerhet': 35,
  'Felsökning & vanliga fel': 15,
}

describe('assistant_faq_entries.pg — seed, RLS and search RPC', () => {
  it('seed migration populated exactly 450 entries with the exact category distribution', async () => {
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
    expect(total).toBe(450)
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
    await withUserContext(userId, async (client) => {
      await expect(
        client.query(
          `INSERT INTO public.assistant_faq_entries
             (id, category, intent, user_questions, short_answer_sv, answer_sv, risk_level, updated_at)
           VALUES ('hack-001', 'Felsökning & vanliga fel', 'hack',
                   '["a?","b?","c?"]'::jsonb, 'x', 'y', 'low', now())`,
        ),
      ).rejects.toThrow(/row-level security/i)

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
    expect(Number(row.entry_count)).toBe(450)
    expect(row.last_seeded_at).toBeTruthy()
    expect(row.last_updated_at).toBeTruthy()
  })
})
