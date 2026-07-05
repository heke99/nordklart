import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentTool } from './types'
import { agentToolRegistry } from './registry'
import { translateReasonCodes } from '@/lib/automation/reason-codes'

// nordklart_explain_transaction_match — lets the assistant answer "varför
// matchades inte transaktionen?" from real data instead of speculation.
// Reads the transaction's automation status, its automation_decisions rows
// (decision, confidence, reason codes) and the payment_match_log audit trail,
// and translates the machine reason codes to Swedish so the model can explain
// concretely what the automation saw and why it stopped.
//
// Read-only; company scoping is enforced twice — explicit company_id filters
// here plus RLS on the underlying tables via the user-scoped client.

// Reason-code → Swedish dictionary lives in lib/automation/reason-codes.ts,
// shared with the transactions and pending-operations UIs so every surface
// explains automation decisions with the same wording.

export const explainTransactionMatchTool: AgentTool = {
  name: 'nordklart_explain_transaction_match',
  description:
    'Hämta den faktiska matchnings- och automationshistoriken för en banktransaktion: automationsbeslut med träffsäkerhet och skälkoder (översatta till svenska) samt matchningsloggen. Använd detta när användaren frågar "varför matchades inte transaktionen?" eller "varför bokfördes den inte automatiskt?" — svara utifrån loggen, aldrig genom att gissa.',
  inputSchema: {
    type: 'object',
    properties: {
      transaction_id: {
        type: 'string',
        description: 'Transaktionens id (uuid).',
      },
    },
    required: ['transaction_id'],
  },
  annotations: { readOnlyHint: true, idempotentHint: true },

  async execute(args, companyId, _userId, supabase: SupabaseClient) {
    const transactionId = typeof args.transaction_id === 'string' ? args.transaction_id : ''
    if (!transactionId) return { error: 'transaction_id krävs' }

    const { data: tx, error: txError } = await supabase
      .from('transactions')
      .select(
        'id, date, description, amount, currency, category, journal_entry_id, invoice_id, automation_status, automation_confidence, automation_decision_id',
      )
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (txError) return { error: txError.message }
    if (!tx) return { error: 'Transaktionen hittades inte i det aktiva företaget.' }

    const [{ data: decisions }, { data: matchLog }] = await Promise.all([
      supabase
        .from('automation_decisions')
        .select('id, decision, confidence, risk_level, reason_codes, status, decided_at, applied_journal_entry_id')
        .eq('transaction_id', transactionId)
        .eq('company_id', companyId)
        .order('decided_at', { ascending: false })
        .limit(10),
      supabase
        .from('payment_match_log')
        .select('action, invoice_id, supplier_invoice_id, match_confidence, match_method, new_state, created_at')
        .eq('transaction_id', transactionId)
        .order('created_at', { ascending: false })
        .limit(20),
    ])

    const decisionRows = (decisions ?? []) as Array<{
      id: string
      decision: string
      confidence: number | null
      risk_level: string
      reason_codes: string[] | null
      status: string
      decided_at: string
      applied_journal_entry_id: string | null
    }>

    const logRows = (matchLog ?? []) as Array<{
      action: string
      invoice_id: string | null
      supplier_invoice_id: string | null
      match_confidence: number | null
      match_method: string | null
      new_state: Record<string, unknown> | null
      created_at: string
    }>

    return {
      transaction: {
        id: tx.id,
        date: tx.date,
        description: tx.description,
        amount: tx.amount,
        currency: tx.currency,
        category: tx.category,
        booked: tx.journal_entry_id !== null,
        matched_invoice_id: tx.invoice_id ?? null,
        automation_status: tx.automation_status ?? null,
        automation_confidence: tx.automation_confidence ?? null,
      },
      automation_decisions: decisionRows.map((d) => ({
        decision: d.decision,
        status: d.status,
        confidence: d.confidence,
        risk_level: d.risk_level,
        decided_at: d.decided_at,
        applied_journal_entry_id: d.applied_journal_entry_id,
        reasons: translateReasonCodes(d.reason_codes ?? []),
      })),
      match_log: logRows.map((l) => ({
        action: l.action,
        invoice_id: l.invoice_id,
        supplier_invoice_id: l.supplier_invoice_id,
        confidence: l.match_confidence,
        method: l.match_method,
        details: l.new_state ?? null,
        at: l.created_at,
      })),
      instruktion:
        decisionRows.length === 0 && logRows.length === 0
          ? 'Ingen automationshistorik finns för transaktionen — den kan ha importerats innan automationen fanns, eller aldrig ha utvärderats. Säg det ärligt; hitta inte på en orsak.'
          : 'Förklara utifrån skälkoderna ovan varför automatiken gjorde som den gjorde. Citera de konkreta skälen (explanation_sv). Spekulera inte utöver loggen.',
    }
  },
}

export function registerMatchLogAgentTool(): void {
  if (!agentToolRegistry.has(explainTransactionMatchTool.name)) {
    agentToolRegistry.register(explainTransactionMatchTool)
  }
}
