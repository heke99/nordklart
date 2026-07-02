import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { explainTransactionMatchTool, registerMatchLogAgentTool } from '../match-log-tool'
import { agentToolRegistry } from '../registry'

// nordklart_explain_transaction_match — grounds "varför matchades inte
// transaktionen?" in real automation_decisions + payment_match_log rows.

interface TableFixture {
  transactions?: { data: unknown; error: unknown }
  automation_decisions?: { data: unknown; error: unknown }
  payment_match_log?: { data: unknown; error: unknown }
}

function makeSupabase(fixture: TableFixture): SupabaseClient {
  return {
    from: (table: string) => {
      const result =
        fixture[table as keyof TableFixture] ?? { data: null, error: null }
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      for (const m of ['select', 'eq', 'order', 'limit']) builder[m] = vi.fn(chain)
      builder.maybeSingle = vi.fn(async () => result)
      // Awaiting the builder directly (list queries) resolves the fixture.
      builder.then = (resolve: (v: unknown) => void) => resolve(result)
      return builder
    },
  } as unknown as SupabaseClient
}

const TX = {
  id: 'tx-1',
  transaction_date: '2026-06-01',
  description: 'BG 123-4567 OCR 987654',
  amount: -1250,
  currency: 'SEK',
  status: 'unmatched',
  journal_entry_id: null,
  matched_invoice_id: null,
  automation_status: 'suggested',
  automation_confidence: 82,
  automation_decision_id: 'dec-1',
}

interface ToolResult {
  error?: string
  transaction?: { id: string; booked: boolean; automation_status: string | null }
  automation_decisions?: Array<{
    decision: string
    reasons: Array<{ code: string; explanation_sv: string }>
  }>
  match_log?: Array<{ action: string }>
  instruktion?: string
}

describe('nordklart_explain_transaction_match', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns translated reason codes from the automation decision', async () => {
    const supabase = makeSupabase({
      transactions: { data: TX, error: null },
      automation_decisions: {
        data: [
          {
            id: 'dec-1',
            decision: 'suggest',
            confidence: 82,
            risk_level: 'normal',
            reason_codes: ['below_auto_confidence', 'ambiguous_candidates'],
            status: 'pending',
            decided_at: '2026-06-01T05:00:00Z',
            applied_journal_entry_id: null,
          },
        ],
        error: null,
      },
      payment_match_log: {
        data: [
          {
            action: 'evaluated',
            invoice_id: 'inv-1',
            supplier_invoice_id: null,
            match_confidence: 82,
            match_method: 'ocr_reference',
            new_state: { candidates: 2 },
            created_at: '2026-06-01T05:00:00Z',
          },
        ],
        error: null,
      },
    })

    const result = (await explainTransactionMatchTool.execute(
      { transaction_id: 'tx-1' },
      'company-1',
      'user-1',
      supabase,
    )) as ToolResult

    expect(result.error).toBeUndefined()
    expect(result.transaction?.id).toBe('tx-1')
    expect(result.transaction?.booked).toBe(false)
    const reasons = result.automation_decisions?.[0]?.reasons ?? []
    const codes = reasons.map((r) => r.code)
    expect(codes).toContain('below_auto_confidence')
    expect(codes).toContain('ambiguous_candidates')
    // Codes are translated to concrete Swedish explanations.
    const ambiguous = reasons.find((r) => r.code === 'ambiguous_candidates')
    expect(ambiguous?.explanation_sv).toContain('kandidater')
    expect(result.match_log?.[0]?.action).toBe('evaluated')
    expect(result.instruktion).toContain('Spekulera inte')
  })

  it('tells the model to be honest when no history exists', async () => {
    const supabase = makeSupabase({
      transactions: { data: TX, error: null },
      automation_decisions: { data: [], error: null },
      payment_match_log: { data: [], error: null },
    })
    const result = (await explainTransactionMatchTool.execute(
      { transaction_id: 'tx-1' },
      'company-1',
      'user-1',
      supabase,
    )) as ToolResult
    expect(result.instruktion).toContain('hitta inte på')
  })

  it('returns an error for a transaction outside the company', async () => {
    const supabase = makeSupabase({
      transactions: { data: null, error: null },
    })
    const result = (await explainTransactionMatchTool.execute(
      { transaction_id: 'tx-other' },
      'company-1',
      'user-1',
      supabase,
    )) as ToolResult
    expect(result.error).toBeTruthy()
  })

  it('requires transaction_id', async () => {
    const supabase = makeSupabase({})
    const result = (await explainTransactionMatchTool.execute(
      {},
      'company-1',
      'user-1',
      supabase,
    )) as ToolResult
    expect(result.error).toBeTruthy()
  })

  it('registers idempotently', () => {
    agentToolRegistry.clear()
    registerMatchLogAgentTool()
    registerMatchLogAgentTool()
    expect(agentToolRegistry.has('nordklart_explain_transaction_match')).toBe(true)
  })
})
