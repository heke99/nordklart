import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentTool } from './types'
import { agentToolRegistry } from './registry'

// nordklart_explain_transaction_match — lets the assistant answer "varför
// matchades inte transaktionen?" from real data instead of speculation.
// Reads the transaction's automation status, its automation_decisions rows
// (decision, confidence, reason codes) and the payment_match_log audit trail,
// and translates the machine reason codes to Swedish so the model can explain
// concretely what the automation saw and why it stopped.
//
// Read-only; company scoping is enforced twice — explicit company_id filters
// here plus RLS on the underlying tables via the user-scoped client.

// Swedish translations for every reason/blocking code the bank automation
// engine emits (lib/automation/bank-transaction-automation.ts). Unknown codes
// pass through verbatim so new codes degrade gracefully.
const REASON_CODE_SV: Record<string, string> = {
  // candidate signals
  own_account_transfer_detected: 'Transaktionen ser ut som en överföring mellan företagets egna konton',
  bank_fee_pattern: 'Texten och beloppet matchar mönstret för en bankavgift',
  tax_payment_pattern: 'Mottagaren matchar Skatteverkets bankgiro (skattekontobetalning)',
  mapping_rule_match: 'En egen bokföringsregel matchade transaktionen',
  booking_template_match: 'En bokningsmall matchade transaktionen',
  counterparty_template_match: 'Motparten har bokförts tidigare — historiken gav ett förslag',
  no_confident_mapping: 'Ingen regel eller historik gav en tillräckligt säker kontering',
  mapping_requires_review: 'Konteringsförslaget kräver manuell granskning (t.ex. oklar moms)',
  exact_amount: 'Beloppet stämmer exakt med fakturans restbelopp',
  partial_or_over_payment: 'Beloppet avviker från fakturans restbelopp (del- eller överbetalning)',
  cross_currency: 'Transaktionen och fakturan har olika valutor',
  already_linked: 'Transaktionen är redan kopplad till en verifikation',
  auto_guards_passed: 'Alla säkerhetsspärrar passerade',
  // blocking guards
  after_sync_mode_blocks_auto: 'Företagets automationsläge tillåter inte automatisk bokföring efter synk',
  below_auto_confidence: 'Träffsäkerheten låg under företagets tröskel för automatisk bokföring',
  ambiguous_candidates: 'Flera kandidater låg för nära varandra i poäng — automatiken vägrar gissa',
  amount_over_auto_cap: 'Beloppet överstiger företagets maxgräns för automatisk bokföring',
  invoice_auto_settlement_disabled: 'Automatisk avräkning av kundfakturor är avstängd i inställningarna',
  not_exact_payment: 'Betalningen är inte exakt lika med fakturabeloppet',
  invoice_disputed: 'Fakturan är markerad som bestriden',
  supplier_auto_link_disabled: 'Automatisk leverantörsavräkning är avstängd i inställningarna',
  bank_fee_auto_disabled: 'Automatisk bokföring av bankavgifter är avstängd',
  bank_fee_amount_unsafe: 'Beloppet är för stort för att säkert vara en bankavgift',
  vat_treatment_unclear: 'Momsbehandlingen är oklar — kräver manuellt val',
  bank_mode_blocks_auto: 'Bankautomationens läge tillåter inte automatisk bokföring',
  fx_transfer_requires_review: 'Valutaöverföring kräver manuell granskning',
  tax_payment_auto_disabled: 'Automatisk bokföring av skattebetalningar är avstängd',
  salary_auto_disabled: 'Automatisk lönekoppling är avstängd',
  category_auto_disabled: 'Automatisk kategoribokning är avstängd',
  no_actionable_candidate: 'Ingen kandidat var tillräckligt konkret för att agera på',
  sie_import_overlap: 'En SIE-import täcker samma period — auto-bokföring spärrad för att undvika dubbelbokning',
  period_locked: 'Bokföringsperioden är stängd eller låst',
  period_status_unknown: 'Periodens status kunde inte fastställas — automatiken avstod',
}

function translateCodes(codes: string[]): Array<{ code: string; explanation_sv: string }> {
  return codes.map((code) => ({
    code,
    explanation_sv: REASON_CODE_SV[code] ?? code,
  }))
}

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
        'id, transaction_date, description, amount, currency, status, journal_entry_id, matched_invoice_id, automation_status, automation_confidence, automation_decision_id',
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
        date: tx.transaction_date,
        description: tx.description,
        amount: tx.amount,
        currency: tx.currency,
        status: tx.status,
        booked: tx.journal_entry_id !== null,
        matched_invoice_id: tx.matched_invoice_id ?? null,
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
        reasons: translateCodes(d.reason_codes ?? []),
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
