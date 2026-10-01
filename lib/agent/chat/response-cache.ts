import { createHash } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import { normalizeSwedishText, searchFaqEntries } from '@/lib/agent/faq/retriever'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent.chat.response-cache')

// Two ways a first turn is answered without calling the model:
//
//   1. FAQ: a typed help question that matches one of the curated FAQ
//      entries almost word for word is answered from that entry. Nothing is
//      generated, so nothing can be invented.
//   2. Saved answers: an answer the model already gave in this company, for
//      the same intent, model, system prompt (hash) and question, is
//      replayed. The prompt hash covers the date, the company profile,
//      memory and VAT status, so any change in context is a cache miss.
//
// Only first turns qualify: later turns depend on the conversation so far.
// Only answers produced without tool calls are saved: tools read live data
// (or stage writes), and replaying their outcome could show stale figures.

/** How long a saved answer may be replayed. The prompt hash usually rotates first (it includes the date). */
const RESPONSE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Intents whose typed questions may be answered straight from the FAQ. */
const FAQ_INTENTS = new Set(['general.help', 'settings.help'])

/** A FAQ entry must beat the runner-up by this much to be used without the model. */
const FAQ_MIN_MARGIN = 0.1

export function responseCacheKey(input: {
  companyId: string
  intentId: string
  model: string
  promptHash: string
  userMessage: string
}): string {
  const normalized = normalizeSwedishText(input.userMessage)
  return createHash('sha256')
    .update([input.companyId, input.intentId, input.model, input.promptHash, normalized].join('\u0000'))
    .digest('hex')
}

/**
 * The FAQ answer for a typed question, or null when the match is not close
 * enough to skip the model. Deliberately strict: the question must contain
 * (or equal) one of the entry's own question variants, the entry must not be
 * high-risk, and no other entry may come close.
 */
export function faqDirectAnswer(intentId: string, userMessage: string): string | null {
  if (!FAQ_INTENTS.has(intentId)) return null
  const question = userMessage.trim()
  if (question.length < 8 || question.length > 300) return null

  const [best, runnerUp] = searchFaqEntries(question, { limit: 2 })
  if (!best) return null
  const nearExact = best.matchedOn.includes('question_exact') || best.matchedOn.includes('question_contains')
  if (!nearExact || best.confidence < 0.9) return null
  if (best.entry.risk_level === 'high') return null
  if (runnerUp && best.confidence - runnerUp.confidence < FAQ_MIN_MARGIN) return null

  return `${best.entry.answer_sv.trim()}\n\nFråga gärna vidare om du vill veta mer.`
}

export async function lookupCachedResponse(
  companyId: string,
  cacheKey: string,
): Promise<{ response: unknown[]; text: string } | null> {
  try {
    const service = createServiceClient()
    const { data, error } = await service.rpc('agent_response_cache_hit', {
      p_company_id: companyId,
      p_cache_key: cacheKey,
    })
    if (error) {
      log.warn('cache lookup failed', { code: error.code })
      return null
    }
    const row = Array.isArray(data) ? data[0] : data
    if (!row || !Array.isArray(row.response)) return null
    return { response: row.response as unknown[], text: String(row.response_text ?? '') }
  } catch (err) {
    log.warn('cache lookup threw', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export async function storeCachedResponse(input: {
  companyId: string
  cacheKey: string
  intentId: string
  model: string
  promptHash: string
  response: unknown[]
  text: string
}): Promise<void> {
  if (input.text.trim().length === 0 || input.text.length > 60_000) return
  try {
    const service = createServiceClient()
    // Opportunistic cleanup keeps the table small without a cron job.
    await service
      .from('agent_response_cache')
      .delete()
      .eq('company_id', input.companyId)
      .lt('expires_at', new Date().toISOString())
    const { error } = await service.from('agent_response_cache').upsert(
      {
        company_id: input.companyId,
        cache_key: input.cacheKey,
        intent_id: input.intentId,
        model: input.model,
        prompt_hash: input.promptHash,
        response: input.response,
        response_text: input.text,
        expires_at: new Date(Date.now() + RESPONSE_TTL_MS).toISOString(),
      },
      { onConflict: 'company_id,cache_key' },
    )
    if (error) log.warn('cache store failed', { code: error.code })
  } catch (err) {
    // A failed save only costs a future model call.
    log.warn('cache store threw', { error: err instanceof Error ? err.message : String(err) })
  }
}
