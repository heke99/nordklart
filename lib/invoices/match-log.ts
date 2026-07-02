import type { SupabaseClient } from '@supabase/supabase-js'

type MatchAction =
  | 'matched'
  | 'unmatched'
  | 'auto_suggested'
  | 'auto_matched'
  /** A candidate was scored but no suggestion/link resulted (blocked/below threshold). */
  | 'evaluated'
  | 'suggestion_cleared'
  | 'storno_conflict_resolved'
  | 'linked_to_existing_voucher'

/**
 * Log a payment match event to the append-only audit trail.
 * Fire-and-forget — never throws, never blocks the caller.
 */
export async function logMatchEvent(
  supabase: SupabaseClient,
  userId: string,
  transactionId: string,
  action: MatchAction,
  opts?: {
    invoiceId?: string
    supplierInvoiceId?: string
    matchConfidence?: number
    matchMethod?: string
    previousState?: Record<string, unknown>
    newState?: Record<string, unknown>
    /** Company scope for the audit row — pass whenever available. */
    companyId?: string
  }
): Promise<void> {
  try {
    await supabase.from('payment_match_log').insert({
      user_id: userId,
      transaction_id: transactionId,
      invoice_id: opts?.invoiceId ?? null,
      supplier_invoice_id: opts?.supplierInvoiceId ?? null,
      ...(opts?.companyId ? { company_id: opts.companyId } : {}),
      action,
      match_confidence: opts?.matchConfidence ?? null,
      match_method: opts?.matchMethod ?? null,
      previous_state: opts?.previousState ?? null,
      new_state: opts?.newState ?? null,
    })
  } catch {
    // Non-critical — audit log insert must never break the main flow
  }
}
