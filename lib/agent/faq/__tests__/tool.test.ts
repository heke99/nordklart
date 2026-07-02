import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { faqSearchTool, registerFaqAgentTool } from '../tool'
import { agentToolRegistry } from '@/lib/agent/tools/registry'

// nordklart_faq_search — the assistant's FAQ-first knowledge tool. The tool
// result carries explicit anti-hallucination instructions: low-confidence
// results tell the model NOT to answer from them, and high-risk matches carry
// their escalation text.

const noRpcSupabase = {
  rpc: async () => ({ data: null, error: { message: 'rpc unavailable' } }),
} as unknown as SupabaseClient

interface ToolResult {
  query?: string
  found?: boolean
  low_confidence?: boolean
  matches?: Array<{
    id: string
    risk_level: string
    escalation: string | null
    confidence: number
    short_answer_sv: string
  }>
  instruktion?: string
  error?: string
}

async function run(args: Record<string, unknown>): Promise<ToolResult> {
  return (await faqSearchTool.execute(
    args,
    'company-1',
    'user-1',
    noRpcSupabase,
  )) as ToolResult
}

describe('nordklart_faq_search tool', () => {
  it('returns the matched FAQ answer for a known question', async () => {
    const result = await run({ query: 'Hur kopplar jag banken?' })
    expect(result.found).toBe(true)
    expect(result.low_confidence).toBe(false)
    expect(result.matches?.[0]?.id).toBe('bank-001')
    expect(result.matches?.[0]?.short_answer_sv.length).toBeGreaterThan(0)
    // The answer-from-FAQ instruction forbids inventing extra rules.
    expect(result.instruktion).toContain('Svara utifrån bästa träffen')
  })

  it('instructs the model to fall back on unrelated questions', async () => {
    const result = await run({ query: 'vilket är det bästa receptet på kanelbullar' })
    expect(result.found).toBe(false)
    expect(result.low_confidence).toBe(true)
    expect(result.instruktion).toContain('Svara INTE')
  })

  it('carries escalation guidance for high-risk topics', async () => {
    const result = await run({ query: 'Ska jag ta lön eller utdelning?' })
    expect(result.found).toBe(true)
    const top = result.matches?.[0]
    expect(top?.risk_level).toBe('high')
    expect(top?.escalation).toBeTruthy()
    expect(result.instruktion).toContain('risk_level')
  })

  it('rejects an empty query', async () => {
    const result = await run({ query: '' })
    expect(result.error).toBeTruthy()
  })

  it('clamps the limit to 1-10', async () => {
    const result = await run({ query: 'hur bokför jag moms', limit: 99 })
    expect((result.matches?.length ?? 0)).toBeLessThanOrEqual(10)
  })

  it('is registered idempotently in the agent tool registry', () => {
    agentToolRegistry.clear()
    registerFaqAgentTool()
    registerFaqAgentTool()
    expect(agentToolRegistry.has('nordklart_faq_search')).toBe(true)
    expect(agentToolRegistry.get('nordklart_faq_search')?.annotations?.readOnlyHint).toBe(true)
  })
})

describe('anti-certainty behavior', () => {
  beforeEach(() => {
    agentToolRegistry.clear()
  })

  it('never claims a booking was made — tool is read-only', () => {
    expect(faqSearchTool.annotations?.readOnlyHint).toBe(true)
    expect(faqSearchTool.annotations?.destructiveHint).not.toBe(true)
  })

  it('low-confidence result includes no authoritative instruction', async () => {
    const result = await run({ query: 'blorp fnord xyzzy' })
    expect(result.found).toBe(false)
    expect(result.instruktion).not.toContain('Svara utifrån bästa träffen')
  })
})
