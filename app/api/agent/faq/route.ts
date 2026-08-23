import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { retrieveFaq, FAQ_HIGH_CONFIDENCE_THRESHOLD } from '@/lib/agent/faq/retriever'
import { getFaqEntries, FAQ_TOTAL_ENTRIES } from '@/lib/agent/faq/dataset'
import { validateBody } from '@/lib/api/validate'
import { z } from 'zod'

// /api/agent/faq — transparency + test surface for the assistant's FAQ
// knowledge base. Powers the "FAQ" tab on /settings/assistant:
//
//   GET  → status: enabled, indexed entry count (DB when seeded, bundled
//          dataset otherwise), last seed date.
//   POST → test question: run the same retrieval the assistant uses and
//          return matched entries with confidence + low-confidence fallback,
//          so users can see exactly what the assistant would ground on.
//
// The FAQ is global knowledge (no company data), but the routes still require
// an authenticated session — the knowledge base is a product surface, not a
// public API.
//
// requireAuth() rather than withRouteContext: the wrapper resolves an active
// company and short-circuits without one, and this surface genuinely has no
// company scope — nothing it reads or returns is tenant data. Imposing a
// company precondition here would invent a requirement the route does not
// have. What requireAuth() adds over the bare getUser() it replaced is the
// AAL2/MFA check.

export async function GET() {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { supabase } = auth

  // Prefer DB truth (seeded rows carry seeded_at); fall back to the bundled
  // dataset when the seed migration hasn't run in this environment yet.
  let indexedEntries = 0
  let lastSeededAt: string | null = null
  let dbSeeded = false
  try {
    const { data, error } = await supabase.rpc('assistant_faq_status')
    const row = Array.isArray(data) ? data[0] : data
    if (!error && row && Number(row.entry_count) > 0) {
      indexedEntries = Number(row.entry_count)
      lastSeededAt = (row.last_seeded_at as string | null) ?? null
      dbSeeded = true
    }
  } catch {
    // fall through to bundled dataset
  }

  if (!dbSeeded) {
    indexedEntries = getFaqEntries().length
  }

  const lastUpdatedAt = getFaqEntries().reduce<string | null>(
    (max, e) => (max === null || e.updated_at > max ? e.updated_at : max),
    null,
  )

  return NextResponse.json({
    data: {
      enabled: true,
      expected_entries: FAQ_TOTAL_ENTRIES,
      indexed_entries: indexedEntries,
      db_seeded: dbSeeded,
      last_seeded_at: lastSeededAt,
      last_updated_at: lastUpdatedAt,
    },
  })
}

const testQuestionSchema = z.object({
  question: z.string().min(2).max(500),
  limit: z.number().int().min(1).max(10).optional(),
})

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { supabase } = auth

  const validation = await validateBody(request, testQuestionSchema)
  if (!validation.success) return validation.response

  const { question, limit } = validation.data
  const result = await retrieveFaq(question, { supabase, limit: limit ?? 3 })

  return NextResponse.json({
    data: {
      query: result.query,
      low_confidence: result.lowConfidence,
      source: result.source,
      matches: result.matches.map((m) => ({
        id: m.entry.id,
        category: m.entry.category,
        intent: m.entry.intent,
        confidence: m.confidence,
        high_confidence: m.confidence >= FAQ_HIGH_CONFIDENCE_THRESHOLD,
        short_answer_sv: m.entry.short_answer_sv,
        answer_sv: m.entry.answer_sv,
        sources: m.entry.sources,
        related_routes: m.entry.related_routes,
        risk_level: m.entry.risk_level,
        escalation: m.entry.escalation,
        matched_on: m.matchedOn,
      })),
    },
  })
}
