import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { getOutputVatAccount } from '@/lib/bookkeeping/revenue-accounts'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { roundOre } from '@/lib/money'
import type { Invoice, VatTreatment } from '@/types'

ensureInitialized()

const ResolutionSchema = z.object({
  action: z.enum(['dispute', 'undispute', 'collection_ready', 'write_off']),
  /** Required for write_off — the audit trail must carry the justification. */
  note: z.string().max(2000).optional(),
  /** Booking date for the write-off entry; defaults to today. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

/**
 * POST /api/invoices/[id]/resolution
 *
 * Customer-ledger state transitions beyond payment:
 *   - dispute / undispute    — customer contests the invoice (blocks
 *                              reminders and auto-matching)
 *   - collection_ready       — flagged for inkasso handover
 *   - write_off              — konstaterad kundförlust: books
 *                              Dr 6351 (net) + Dr 26xx (VAT reclaim) /
 *                              Cr 1510 for the remaining amount and closes
 *                              the invoice as written_off.
 *
 * The write-off VAT reclaim (ML 7 kap 44 §) requires the loss to be
 * KONSTATERAD — the caller asserts this via the mandatory note.
 */
export const POST = withRouteContext(
  'invoice.resolution',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ invoiceId: id })

    const validation = await validateBody(request, ResolutionSchema, {
      log: opLog,
      operation: 'invoice.resolution',
    })
    if (!validation.success) return validation.response
    const { action, note, date } = validation.data

    const { data: invoice, error: fetchError } = await supabase
      .from('invoices')
      .select('*, customer:customers(id, name)')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fetchError || !invoice) {
      return errorResponseFromCode('INVOICE_PAID_NOT_FOUND', opLog, { requestId })
    }
    const typed = invoice as Invoice & { customer?: { name?: string } }

    const nowIso = new Date().toISOString()

    if (action === 'dispute') {
      if (!['sent', 'overdue', 'partially_paid', 'collection_ready'].includes(typed.status)) {
        return errorResponseFromCode('VALIDATION_ERROR', opLog, {
          requestId,
          details: { field: 'action', message: `Fakturan kan inte bestridas i status ${typed.status}.` },
        })
      }
      const { error } = await supabase
        .from('invoices')
        .update({
          status: 'disputed',
          disputed_at: nowIso,
          payment_resolution_status: 'has_difference',
          ...(note ? { payment_resolution_notes: note } : {}),
        })
        .eq('id', id)
        .eq('company_id', companyId)
        .in('status', ['sent', 'overdue', 'partially_paid', 'collection_ready'])
      if (error) return errorResponse(error, opLog, { requestId })
      opLog.info('invoice disputed', { userId: user.id })
      return NextResponse.json({ success: true, status: 'disputed' })
    }

    if (action === 'undispute') {
      if (typed.status !== 'disputed') {
        return errorResponseFromCode('VALIDATION_ERROR', opLog, {
          requestId,
          details: { field: 'action', message: 'Endast bestridna fakturor kan återställas.' },
        })
      }
      // Back to overdue when past due, else sent (partially paid retains that).
      const paidAmount = typed.paid_amount ?? 0
      const today = new Date().toISOString().split('T')[0]
      const restoredStatus =
        paidAmount > 0 ? 'partially_paid' : typed.due_date && typed.due_date < today ? 'overdue' : 'sent'
      const { error } = await supabase
        .from('invoices')
        .update({
          status: restoredStatus,
          disputed_at: null,
          payment_resolution_status: 'open',
          ...(note ? { payment_resolution_notes: note } : {}),
        })
        .eq('id', id)
        .eq('company_id', companyId)
        .eq('status', 'disputed')
      if (error) return errorResponse(error, opLog, { requestId })
      opLog.info('invoice dispute cleared', { userId: user.id, restoredStatus })
      return NextResponse.json({ success: true, status: restoredStatus })
    }

    if (action === 'collection_ready') {
      if (!['sent', 'overdue', 'partially_paid'].includes(typed.status)) {
        return errorResponseFromCode('VALIDATION_ERROR', opLog, {
          requestId,
          details: { field: 'action', message: `Fakturan kan inte skickas till inkasso i status ${typed.status}.` },
        })
      }
      const { error } = await supabase
        .from('invoices')
        .update({
          status: 'collection_ready',
          collection_ready_at: nowIso,
          payment_resolution_status: 'collection',
          ...(note ? { payment_resolution_notes: note } : {}),
        })
        .eq('id', id)
        .eq('company_id', companyId)
        .in('status', ['sent', 'overdue', 'partially_paid'])
      if (error) return errorResponse(error, opLog, { requestId })
      opLog.info('invoice flagged collection_ready', { userId: user.id })
      return NextResponse.json({ success: true, status: 'collection_ready' })
    }

    // ── write_off — konstaterad kundförlust ─────────────────────────────────
    if (!note || note.trim().length < 5) {
      return errorResponseFromCode('VALIDATION_ERROR', opLog, {
        requestId,
        details: {
          field: 'note',
          message: 'Ange en motivering — kundförlusten måste vara konstaterad (t.ex. konkurs, misslyckad indrivning).',
        },
      })
    }
    if (!['sent', 'overdue', 'partially_paid', 'disputed', 'collection_ready'].includes(typed.status)) {
      return errorResponseFromCode('VALIDATION_ERROR', opLog, {
        requestId,
        details: { field: 'action', message: `Fakturan kan inte skrivas av i status ${typed.status}.` },
      })
    }

    const remaining = roundOre(typed.remaining_amount ?? typed.total)
    if (remaining <= 0) {
      return errorResponseFromCode('VALIDATION_ERROR', opLog, {
        requestId,
        details: { field: 'amount', message: 'Fakturan saknar restbelopp att skriva av.' },
      })
    }

    // Journal entry only when the invoice carries a receivable on the books
    // (accrual-booked). A never-booked kontantmetoden invoice has nothing on
    // 1510 — the write-off is a pure status change.
    const bookingDate = date || new Date().toISOString().split('T')[0]
    let journalEntryId: string | null = null
    const invoiceBooked = !!(typed as { journal_entry_id?: string | null }).journal_entry_id
    if (invoiceBooked) {
      try {
        const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, bookingDate)
        if (!fiscalPeriodId) {
          return errorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', opLog, {
            requestId,
            details: { date: bookingDate },
          })
        }
        // Proportional VAT reclaim on the written-off remainder.
        const vatShare =
          typed.total > 0 && typed.vat_amount > 0
            ? roundOre((typed.vat_amount * remaining) / typed.total)
            : 0
        const netShare = roundOre(remaining - vatShare)
        const vatAccount = getOutputVatAccount((typed.vat_treatment ?? 'standard_25') as VatTreatment)

        const lines = [
          {
            account_number: '6351',
            debit_amount: netShare,
            credit_amount: 0,
            line_description: 'Konstaterad kundförlust',
          },
          ...(vatShare > 0
            ? [{
                account_number: vatAccount,
                debit_amount: vatShare,
                credit_amount: 0,
                line_description: 'Återförd utgående moms, kundförlust (ML 7 kap 44 §)',
              }]
            : []),
          {
            account_number: '1510',
            debit_amount: 0,
            credit_amount: remaining,
            line_description: `Avskrivning kundfordran faktura ${typed.invoice_number}`,
          },
        ]

        const entry = await createJournalEntry(supabase, companyId, user.id, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: bookingDate,
          description: typed.customer?.name
            ? `Kundförlust faktura ${typed.invoice_number}, ${typed.customer.name}`
            : `Kundförlust faktura ${typed.invoice_number}`,
          source_type: 'invoice_paid',
          source_id: id,
          lines,
        })
        journalEntryId = entry?.id ?? null
      } catch (err) {
        if (isBookkeepingError(err)) {
          return errorResponse(err, opLog, { requestId })
        }
        opLog.error('write-off journal entry failed', err as Error)
        return errorResponseFromCode('INVOICE_PAID_BOOK_FAILED', opLog, {
          requestId,
          details: { reason: err instanceof Error ? err.message : 'unknown' },
        })
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from('invoices')
      .update({
        status: 'written_off',
        written_off_at: nowIso,
        remaining_amount: 0,
        payment_resolution_status: 'written_off',
        payment_resolution_notes: note,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .in('status', ['sent', 'overdue', 'partially_paid', 'disputed', 'collection_ready'])
      .select('id')

    if (updateError) return errorResponse(updateError, opLog, { requestId })
    if (!updated || updated.length === 0) {
      return errorResponseFromCode('INVOICE_PAID_RACE', opLog, { requestId })
    }

    opLog.info('invoice written off', {
      userId: user.id,
      remaining,
      journalEntryId,
    })

    return NextResponse.json({
      success: true,
      status: 'written_off',
      written_off_amount: remaining,
      journal_entry_id: journalEntryId,
    })
  },
  { requireWrite: true },
)
