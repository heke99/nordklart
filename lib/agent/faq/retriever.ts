import type { SupabaseClient } from '@supabase/supabase-js'
import { getFaqEntries, type FaqEntry } from './dataset'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent.faq.retriever')

// FAQ retrieval for the assistant (Batch 10).
//
// Two search paths, always available:
//   1. In-process keyword scoring over the bundled dataset — deterministic,
//      zero-latency, works in tests and when the DB is unreachable.
//   2. Postgres tsvector RPC (search_assistant_faq, swedish config) when a
//      Supabase client is provided — used as a rank booster so stemming the
//      in-process tokenizer misses still surfaces the right entry.
//
// pgvector embeddings can be layered on later as a third signal without
// changing this module's public contract.
//
// The retriever NEVER invents an answer: below the confidence threshold it
// returns lowConfidence=true and the caller (agent tool / settings UI) is
// expected to fall back to skills or say "jag hittar inget säkert svar".

export interface FaqMatch {
  entry: FaqEntry
  // 0..1 — calibrated so ≥ HIGH is a direct hit on a question variant and
  // < LOW means "do not present this as an authoritative answer".
  confidence: number
  // Which fields contributed (debug/telemetry + settings-UI display).
  matchedOn: string[]
}

export interface FaqRetrievalResult {
  query: string
  matches: FaqMatch[]
  // True when the best match is below FAQ_LOW_CONFIDENCE_THRESHOLD — the
  // caller must not answer from the FAQ in that case.
  lowConfidence: boolean
  source: 'local' | 'hybrid'
}

// Best-match confidence below this → lowConfidence (fallback to skills).
export const FAQ_LOW_CONFIDENCE_THRESHOLD = 0.35
// At or above this the answer can be presented directly.
export const FAQ_HIGH_CONFIDENCE_THRESHOLD = 0.6

// ── Swedish text normalization ──────────────────────────────────────────────

// Question words and glue that appear in nearly every FAQ query and carry no
// discriminating signal. å/ä/ö are preserved — they are semantic in Swedish.
const SWEDISH_STOPWORDS = new Set([
  'och', 'att', 'det', 'som', 'en', 'ett', 'jag', 'hur', 'vad', 'är', 'för',
  'på', 'i', 'med', 'till', 'av', 'om', 'den', 'de', 'min', 'mitt', 'mina',
  'kan', 'ska', 'vill', 'gör', 'man', 'har', 'inte', 'sig', 'från', 'eller',
  'vid', 'så', 'du', 'din', 'ditt', 'dina', 'när', 'var', 'vem', 'vilka',
  'vilket', 'vilken', 'ju', 'nu', 'då', 'här', 'där', 'detta', 'dessa',
  'behöver', 'måste', 'får', 'finns', 'göra', 'göras', 'blir', 'bli',
  'mig', 'oss', 'vår', 'vårt', 'våra', 'hos', 'via', 'utan', 'under', 'över',
  'efter', 'innan', 'mot', 'per', 'ur', 'än', 'men', 'bara', 'också', 'även',
])

export function normalizeSwedishText(text: string): string {
  return text
    .toLowerCase()
    // Fold accents except å/ä/ö (é→e, ü→u …).
    .replace(/[éè]/g, 'e')
    .replace(/[üû]/g, 'u')
    .replace(/[áà]/g, 'a')
    // Strip everything that isn't a letter, digit or whitespace.
    .replace(/[^a-z0-9åäö\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Light suffix stripping so inflections match ("fakturan" → "faktur",
// "bokförs" → "bokför"). Not a real stemmer — intentionally conservative:
// only strip when a reasonably long stem remains.
const SUFFIXES = [
  'ningarna', 'ningarnas', 'heterna', 'ningen', 'ningar', 'erna', 'arna',
  'orna', 'ande', 'ende', 'aste', 'ades', 'erns', 'aren', 'aget',
  'en', 'et', 'er', 'ar', 'or', 'na', 'de', 'ad', 'at', 'as', 'es', 's', 'a',
]

export function stemSwedishToken(token: string): string {
  if (token.length <= 4) return token
  for (const suffix of SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      return token.slice(0, token.length - suffix.length)
    }
  }
  return token
}

export function tokenizeSwedish(text: string): string[] {
  const normalized = normalizeSwedishText(text)
  const tokens: string[] = []
  for (const raw of normalized.split(' ')) {
    if (raw.length < 2) continue
    if (SWEDISH_STOPWORDS.has(raw)) continue
    tokens.push(stemSwedishToken(raw))
  }
  return tokens
}

// Does a query token "hit" inside a set of entry tokens? Exact stem match,
// or compound containment for longer tokens ("lönekörning" inside
// "lönekörningen" or "korrigeringslönekörning").
function tokenHits(queryToken: string, entryTokens: Set<string>, entryText: string): boolean {
  if (entryTokens.has(queryToken)) return true
  if (queryToken.length >= 5 && entryText.includes(queryToken)) return true
  return false
}

// ── In-process index (built once per process) ───────────────────────────────

interface IndexedEntry {
  entry: FaqEntry
  questionVariants: string[] // normalized full variants for exact matching
  questionTokens: Set<string>
  questionText: string
  intentTokens: Set<string>
  intentText: string
  shortTokens: Set<string>
  shortText: string
  answerTokens: Set<string>
  answerText: string
  categoryTokens: Set<string>
  categoryText: string
}

let indexCache: IndexedEntry[] | null = null

function buildIndex(entries: FaqEntry[]): IndexedEntry[] {
  return entries.map((entry) => {
    const questionJoined = entry.user_questions.join(' ')
    const intentText = entry.intent.replace(/_/g, ' ')
    return {
      entry,
      questionVariants: entry.user_questions.map(normalizeSwedishText),
      questionTokens: new Set(tokenizeSwedish(questionJoined)),
      questionText: normalizeSwedishText(questionJoined),
      intentTokens: new Set(tokenizeSwedish(intentText)),
      intentText: normalizeSwedishText(intentText),
      shortTokens: new Set(tokenizeSwedish(entry.short_answer_sv)),
      shortText: normalizeSwedishText(entry.short_answer_sv),
      answerTokens: new Set(tokenizeSwedish(entry.answer_sv)),
      answerText: normalizeSwedishText(entry.answer_sv),
      categoryTokens: new Set(tokenizeSwedish(entry.category)),
      categoryText: normalizeSwedishText(entry.category),
    }
  })
}

function getIndex(entries?: FaqEntry[]): IndexedEntry[] {
  if (entries) return buildIndex(entries)
  if (!indexCache) indexCache = buildIndex(getFaqEntries())
  return indexCache
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const FIELD_WEIGHTS = {
  question: 1.0,
  intent: 0.85,
  short: 0.55,
  answer: 0.3,
  category: 0.25,
} as const

function scoreEntry(
  queryTokens: string[],
  normalizedQuery: string,
  indexed: IndexedEntry,
): { score: number; matchedOn: string[] } {
  const matchedOn = new Set<string>()

  // Exact (or contained) question-variant match is a direct hit.
  for (const variant of indexed.questionVariants) {
    if (variant === normalizedQuery) {
      return { score: 1.0, matchedOn: ['question_exact'] }
    }
    if (
      normalizedQuery.length >= 12 &&
      (variant.includes(normalizedQuery) || normalizedQuery.includes(variant))
    ) {
      matchedOn.add('question_contains')
    }
  }

  if (queryTokens.length === 0) {
    return { score: matchedOn.size > 0 ? 0.7 : 0, matchedOn: [...matchedOn] }
  }

  // Per-token best-field coverage: each query token contributes the weight of
  // the strongest field it appears in. Total is normalized by token count so
  // long queries aren't penalized.
  let total = 0
  for (const token of queryTokens) {
    let tokenScore = 0
    if (tokenHits(token, indexed.questionTokens, indexed.questionText)) {
      tokenScore = FIELD_WEIGHTS.question
      matchedOn.add('question')
    } else if (tokenHits(token, indexed.intentTokens, indexed.intentText)) {
      tokenScore = FIELD_WEIGHTS.intent
      matchedOn.add('intent')
    } else if (tokenHits(token, indexed.shortTokens, indexed.shortText)) {
      tokenScore = FIELD_WEIGHTS.short
      matchedOn.add('short_answer')
    } else if (tokenHits(token, indexed.answerTokens, indexed.answerText)) {
      tokenScore = FIELD_WEIGHTS.answer
      matchedOn.add('answer')
    } else if (tokenHits(token, indexed.categoryTokens, indexed.categoryText)) {
      tokenScore = FIELD_WEIGHTS.category
      matchedOn.add('category')
    }
    total += tokenScore
  }

  let score = total / queryTokens.length
  if (matchedOn.has('question_contains')) {
    // The query contains a full question variant (or vice versa) — that is a
    // near-exact hit and must outrank entries that merely share many tokens.
    score = Math.max(score, 0.9)
  }
  return { score: Math.min(score, 0.99), matchedOn: [...matchedOn] }
}

// Pure in-process search — used directly by tests and as the local leg of
// retrieveFaq. `entries` override exists for tests; production uses the
// bundled dataset via a cached index.
export function searchFaqEntries(
  query: string,
  options?: { limit?: number; entries?: FaqEntry[] },
): FaqMatch[] {
  const limit = options?.limit ?? 5
  const normalizedQuery = normalizeSwedishText(query)
  const queryTokens = tokenizeSwedish(query)
  if (normalizedQuery.length === 0) return []

  const index = getIndex(options?.entries)
  const scored: FaqMatch[] = []
  for (const indexed of index) {
    const { score, matchedOn } = scoreEntry(queryTokens, normalizedQuery, indexed)
    if (score > 0) {
      scored.push({ entry: indexed.entry, confidence: round2(score), matchedOn })
    }
  }
  scored.sort(
    (a, b) => b.confidence - a.confidence || (a.entry.id < b.entry.id ? -1 : 1),
  )
  return scored.slice(0, limit)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ── Hybrid retrieval (local + tsvector RPC) ─────────────────────────────────

interface RpcRow {
  id: string
  rank: number
}

export async function retrieveFaq(
  query: string,
  options?: { supabase?: SupabaseClient | null; limit?: number },
): Promise<FaqRetrievalResult> {
  const limit = options?.limit ?? 5
  const local = searchFaqEntries(query, { limit: Math.max(limit * 2, 10) })

  let source: 'local' | 'hybrid' = 'local'
  const combined = new Map<string, FaqMatch>()
  for (const m of local) combined.set(m.entry.id, m)

  if (options?.supabase) {
    try {
      const { data, error } = await options.supabase.rpc('search_assistant_faq', {
        p_query: query,
        p_limit: limit,
      })
      if (!error && Array.isArray(data)) {
        source = 'hybrid'
        // tsvector ranks are unbounded; normalize against the best row and
        // blend: an entry found by BOTH legs gets a boost, an entry found by
        // the RPC alone enters with moderate confidence (Postgres' swedish
        // stemmer catches inflections our light stemmer misses).
        const rows = data as RpcRow[]
        const maxRank = rows.reduce((m, r) => Math.max(m, r.rank ?? 0), 0) || 1
        for (const row of rows) {
          const rpcConfidence = 0.3 + 0.4 * ((row.rank ?? 0) / maxRank)
          const existing = combined.get(row.id)
          if (existing) {
            existing.confidence = round2(
              Math.min(0.99, Math.max(existing.confidence, rpcConfidence) + 0.08),
            )
            if (!existing.matchedOn.includes('tsvector')) existing.matchedOn.push('tsvector')
          } else {
            const entry = getFaqEntries().find((e) => e.id === row.id)
            if (entry) {
              combined.set(row.id, {
                entry,
                confidence: round2(rpcConfidence),
                matchedOn: ['tsvector'],
              })
            }
          }
        }
      }
    } catch (err) {
      // RPC failure must never break retrieval — the local leg stands alone.
      log.warn('search_assistant_faq RPC failed; falling back to local search', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const matches = [...combined.values()]
    .sort((a, b) => b.confidence - a.confidence || (a.entry.id < b.entry.id ? -1 : 1))
    .slice(0, limit)

  const best = matches[0]?.confidence ?? 0
  return {
    query,
    matches,
    lowConfidence: best < FAQ_LOW_CONFIDENCE_THRESHOLD,
    source,
  }
}
