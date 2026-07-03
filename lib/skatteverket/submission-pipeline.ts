import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'

/**
 * Unified tax-submission pipeline (tax_submissions + tax_submission_events).
 *
 * Every Skatteverket flow (moms, AGI, …) mirrors its state transitions into
 * these tables so ONE queryable pipeline powers /skatteverket, the agency
 * work queue and the platform monitoring view — regardless of which
 * underlying mechanism (per-BankID extension, sysorg, manual export) drove
 * the filing.
 *
 * Status model (tax_submissions.status):
 *   draft                 → underlag beräknat lokalt
 *   prepared              → validerad mot SKV:s kontroller ("validated")
 *   sent_to_skatteverket  → utkast uppladdat till eget utrymme
 *                           ("uploaded_to_own_space")
 *   waiting_for_signature → utkast låst; signering krävs i SKV:s tjänst
 *   signed_submitted      → inlämnad (signerad av behörig person)
 *   receipt_received      → kvittens/beslut hämtat
 *   failed                → avvisad/fel ("rejected"/"correction_required" —
 *                           details in error_message + event payload)
 *   cancelled             → utkast raderat / flöde avbrutet
 *
 * All writers are BEST-EFFORT: a pipeline write failure must never abort the
 * actual Skatteverket call — the extension's own state (extension_data,
 * agi_declarations) remains the operational source; this table is the
 * unified reporting/audit layer. Failures are logged by the caller.
 */

export type TaxSubmissionType = 'vat_return' | 'agi' | 'skattekonto_reconciliation' | 'income_tax' | 'other'

export type TaxSubmissionStatus =
  | 'draft'
  | 'prepared'
  | 'sent_to_skatteverket'
  | 'waiting_for_signature'
  | 'signed_submitted'
  | 'receipt_received'
  | 'failed'
  | 'cancelled'

export interface TransitionArgs {
  companyId: string
  userId: string | null
  submissionType: TaxSubmissionType
  /** Period key, e.g. redovisningsperiod '202606'. */
  periodKey: string
  status: TaxSubmissionStatus
  /** Event type describing WHAT happened (e.g. 'moms.draft_saved'). */
  eventType: string
  message?: string | null
  amount?: number | null
  skatteverketReference?: string | null
  receiptReference?: string | null
  receiptPayload?: Record<string, unknown> | null
  errorMessage?: string | null
  payload?: Record<string, unknown>
}

/**
 * Find-or-create the submission row for (company, type, period) and apply
 * the status transition + append the event row. Returns the submission id
 * or null on failure (best-effort).
 */
export async function transitionTaxSubmission(
  supabase: SupabaseClient,
  args: TransitionArgs,
): Promise<string | null> {
  try {
    const { data: existing } = await supabase
      .from('tax_submissions')
      .select('id, status')
      .eq('company_id', args.companyId)
      .eq('submission_type', args.submissionType)
      .eq('period_key', args.periodKey)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const now = new Date().toISOString()
    const statusFields: Record<string, unknown> = {
      status: args.status,
      updated_at: now,
      ...(args.amount != null ? { amount: args.amount } : {}),
      ...(args.skatteverketReference ? { skatteverket_reference: args.skatteverketReference } : {}),
      ...(args.receiptReference ? { receipt_reference: args.receiptReference } : {}),
      ...(args.receiptPayload ? { receipt_payload: args.receiptPayload } : {}),
      ...(args.errorMessage !== undefined ? { error_message: args.errorMessage } : {}),
    }
    // Actor/timestamp columns per lifecycle step.
    if (args.status === 'prepared') {
      statusFields.prepared_by = args.userId
      statusFields.prepared_at = now
    } else if (args.status === 'sent_to_skatteverket' || args.status === 'waiting_for_signature') {
      statusFields.sent_by = args.userId
      statusFields.sent_at = now
    } else if (args.status === 'signed_submitted') {
      statusFields.signed_by = args.userId
      statusFields.signed_at = now
    } else if (args.status === 'receipt_received') {
      statusFields.receipt_received_at = now
    }

    let submissionId: string
    let statusFrom: string | null = null

    if (existing) {
      submissionId = (existing as { id: string }).id
      statusFrom = (existing as { status: string }).status
      await supabase
        .from('tax_submissions')
        .update(statusFields)
        .eq('id', submissionId)
        .eq('company_id', args.companyId)
    } else {
      const { data: created, error: insertErr } = await supabase
        .from('tax_submissions')
        .insert({
          company_id: args.companyId,
          submission_type: args.submissionType,
          period_key: args.periodKey,
          requires_signature: true,
          ...statusFields,
          created_at: now,
        })
        .select('id')
        .single()
      if (insertErr || !created) return null
      submissionId = (created as { id: string }).id
    }

    await supabase.from('tax_submission_events').insert({
      company_id: args.companyId,
      tax_submission_id: submissionId,
      event_type: args.eventType,
      status_from: statusFrom,
      status_to: args.status,
      message: args.message ?? null,
      payload: args.payload ?? {},
      created_by: args.userId,
    })

    // Webhook-facing bus events for the externally interesting transitions.
    // Best-effort like everything else in this pipeline.
    try {
      const base = {
        submissionId,
        submissionType: args.submissionType as string,
        periodKey: args.periodKey,
        userId: args.userId ?? '',
        companyId: args.companyId,
      }
      if (args.status === 'prepared' && args.submissionType === 'vat_return') {
        await eventBus.emit({
          type: 'vat_report.generated',
          payload: {
            submissionId,
            periodKey: args.periodKey,
            amount: args.amount ?? null,
            userId: args.userId ?? '',
            companyId: args.companyId,
          },
        })
      } else if (args.status === 'waiting_for_signature') {
        await eventBus.emit({ type: 'tax_submission.waiting_for_signature', payload: base })
      } else if (args.status === 'signed_submitted') {
        await eventBus.emit({
          type: 'tax_submission.submitted',
          payload: { ...base, skatteverketReference: args.skatteverketReference ?? null },
        })
      } else if (args.status === 'failed') {
        await eventBus.emit({
          type: 'tax_submission.failed',
          payload: { ...base, errorMessage: args.errorMessage ?? null },
        })
      }
    } catch {
      // Never break the SKV flow over event emission.
    }

    return submissionId
  } catch {
    // Best-effort — never break the SKV flow over pipeline telemetry.
    return null
  }
}

/** Swedish labels for the unified pipeline statuses (UI + assistant). */
export const TAX_SUBMISSION_STATUS_SV: Record<TaxSubmissionStatus, string> = {
  draft: 'Utkast (beräknat lokalt)',
  prepared: 'Validerad',
  sent_to_skatteverket: 'Uppladdad till eget utrymme hos Skatteverket',
  waiting_for_signature: 'Väntar på signering hos Skatteverket',
  signed_submitted: 'Inlämnad (signerad)',
  receipt_received: 'Kvittens mottagen',
  failed: 'Avvisad / fel',
  cancelled: 'Avbruten',
}
