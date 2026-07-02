import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { translateReasonCodes } from '@/lib/automation/reason-codes'

// GET /api/transactions/[id]/automation — the automation decision trail for
// one transaction (Batch 11 transparency): status, confidence, decisions with
// Swedish-translated reason codes, staged pending operation, and the match
// log. Powers the "Varför?"-popover in the transactions UI; the assistant
// reads the same data via nordklart_explain_transaction_match.

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'transactions.automation.read',
  async (_request, ctx, { params }) => {
    const { supabase, companyId } = ctx
    const { id: transactionId } = await params

    const { data: tx, error: txError } = await supabase
      .from('transactions')
      .select(
        'id, transaction_date, description, amount, currency, journal_entry_id, matched_invoice_id, potential_invoice_id, automation_status, automation_confidence, automation_decision_id',
      )
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .maybeSingle()

    if (txError) {
      return NextResponse.json({ error: txError.message }, { status: 500 })
    }
    if (!tx) {
      return NextResponse.json({ error: 'Transaktionen hittades inte' }, { status: 404 })
    }

    const [{ data: decisions }, { data: pendingOps }, { data: matchLog }] = await Promise.all([
      supabase
        .from('automation_decisions')
        .select('id, decision, confidence, risk_level, reason_codes, status, decided_at, applied_journal_entry_id, metadata')
        .eq('transaction_id', transactionId)
        .eq('company_id', companyId)
        .order('decided_at', { ascending: false })
        .limit(5),
      supabase
        .from('pending_operations')
        .select('id, operation_type, title, status, created_at')
        .eq('company_id', companyId)
        .contains('params', { transaction_id: transactionId })
        .order('created_at', { ascending: false })
        .limit(5),
      supabase
        .from('payment_match_log')
        .select('action, invoice_id, supplier_invoice_id, match_confidence, match_method, created_at')
        .eq('transaction_id', transactionId)
        .order('created_at', { ascending: false })
        .limit(10),
    ])

    return NextResponse.json({
      data: {
        transaction: {
          id: tx.id,
          automation_status: tx.automation_status ?? null,
          automation_confidence: tx.automation_confidence ?? null,
          booked: tx.journal_entry_id !== null,
          matched_invoice_id: tx.matched_invoice_id ?? null,
          potential_invoice_id: tx.potential_invoice_id ?? null,
        },
        decisions: ((decisions ?? []) as Array<{
          id: string
          decision: string
          confidence: number | null
          risk_level: string
          reason_codes: string[] | null
          status: string
          decided_at: string
          applied_journal_entry_id: string | null
          metadata: Record<string, unknown> | null
        }>).map((d) => ({
          id: d.id,
          decision: d.decision,
          status: d.status,
          confidence: d.confidence,
          risk_level: d.risk_level,
          decided_at: d.decided_at,
          applied_journal_entry_id: d.applied_journal_entry_id,
          reasons: translateReasonCodes(d.reason_codes ?? []),
        })),
        pending_operations: ((pendingOps ?? []) as Array<{
          id: string
          operation_type: string
          title: string
          status: string
          created_at: string
        }>).map((p) => ({
          id: p.id,
          operation_type: p.operation_type,
          title: p.title,
          status: p.status,
          created_at: p.created_at,
        })),
        match_log: ((matchLog ?? []) as Array<{
          action: string
          invoice_id: string | null
          supplier_invoice_id: string | null
          match_confidence: number | null
          match_method: string | null
          created_at: string
        }>).map((l) => ({
          action: l.action,
          invoice_id: l.invoice_id,
          supplier_invoice_id: l.supplier_invoice_id,
          confidence: l.match_confidence,
          method: l.match_method,
          at: l.created_at,
        })),
      },
    })
  },
)
