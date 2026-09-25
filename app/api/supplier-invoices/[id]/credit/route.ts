import { NextResponse } from 'next/server'
import { roundOre } from '@/lib/money'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { createSupplierCreditNoteEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { SupplierInvoice, SupplierInvoiceItem, AccountingMethod } from '@/types'

ensureInitialized()

export const POST = withRouteContext(
  'supplier_invoice.credit',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ supplierInvoiceId: id })

    const { data: original, error: fetchError } = await supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !original) {
      return errorResponseFromCode('SI_NOT_FOUND', opLog, { requestId })
    }

    if (original.status === 'credited') {
      return errorResponseFromCode('SI_CREDIT_ALREADY_CREDITED', opLog, { requestId })
    }

    const { data: arrivalNum, error: arrivalError } = await supabase
      .rpc('get_next_arrival_number', { p_company_id: companyId })
    if (arrivalError || arrivalNum == null) {
      opLog.error('arrival number allocation failed', arrivalError as Error)
      return errorResponseFromCode('SI_CREDIT_FAILED', opLog, {
        requestId,
        details: { reason: arrivalError?.message ?? 'no arrival number', step: 'arrival_number' },
      })
    }

    const { data: creditNote, error: creditError } = await supabase
      .from('supplier_invoices')
      .insert({
        user_id: user.id,
        company_id: companyId,
        supplier_id: original.supplier_id,
        arrival_number: arrivalNum,
        supplier_invoice_number: `KREDIT-${original.supplier_invoice_number}`,
        invoice_date: new Date().toISOString().split('T')[0],
        due_date: new Date().toISOString().split('T')[0],
        status: 'registered',
        currency: original.currency,
        exchange_rate: original.exchange_rate,
        vat_treatment: original.vat_treatment,
        reverse_charge: original.reverse_charge,
        subtotal: original.subtotal,
        subtotal_sek: original.subtotal_sek,
        vat_amount: original.vat_amount,
        vat_amount_sek: original.vat_amount_sek,
        total: original.total,
        total_sek: original.total_sek,
        remaining_amount: 0,
        is_credit_note: true,
        credited_invoice_id: id,
      })
      .select()
      .single()

    if (creditError || !creditNote) {
      opLog.error('credit note insert failed', creditError as Error)
      return errorResponseFromCode('SI_CREDIT_FAILED', opLog, {
        requestId,
        details: { reason: creditError?.message || 'unknown' },
      })
    }

    const creditItems = (original.items || []).map((item: SupplierInvoiceItem) => ({
      supplier_invoice_id: creditNote.id,
      sort_order: item.sort_order,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      line_total: item.line_total,
      account_number: item.account_number,
      vat_code: item.vat_code,
      vat_rate: item.vat_rate,
      vat_amount: item.vat_amount,
      // Preserve the self-assessed RC rate so the credit-note verifikat
      // reverses fiktiv moms at the same rate the original was booked at.
      reverse_charge_rate: item.reverse_charge_rate,
    }))

    const { error: itemsError } = await supabase.from('supplier_invoice_items').insert(creditItems)
    if (itemsError) {
      await supabase.from('supplier_invoices').delete().eq('id', creditNote.id).eq('company_id', companyId)
      opLog.error('credit note items insert failed; removed the credit note', itemsError as Error)
      return errorResponseFromCode('SI_CREDIT_FAILED', opLog, {
        requestId,
        details: { reason: itemsError.message, step: 'credit_note_items' },
      })
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = (settings?.accounting_method as AccountingMethod) || 'accrual'

    // Cash method: skip — no original registration entry to reverse;
    // recognition is deferred until refund.
    let journalEntryId: string | null = null
    if (accountingMethod === 'accrual') {
      try {
        const journalEntry = await createSupplierCreditNoteEntry(
          supabase, companyId!, user.id,
          creditNote as SupplierInvoice,
          creditItems as SupplierInvoiceItem[],
          original.supplier?.supplier_type || 'swedish_business',
          original.supplier?.name,
        )
        if (!journalEntry) throw new Error('Ingen verifikation skapades.')
        journalEntryId = journalEntry.id
      } catch (err) {
        // createJournalEntry is idempotent per credit note: when it throws,
        // no voucher for this credit note is posted. Roll back the orphan
        // credit-note row (items cascade-delete) — same momsdeklaration-
        // integrity concern as the POST route.
        await supabase.from('supplier_invoices').delete().eq('id', creditNote.id).eq('company_id', companyId)

        if (isBookkeepingError(err)) {
          return errorResponse(err, opLog, { requestId })
        }
        opLog.error('failed to create credit note journal entry', err as Error)
        return errorResponseFromCode('SI_CREDIT_FAILED', opLog, {
          requestId,
          details: {
            reason: err instanceof Error ? err.message : 'unknown',
            step: 'credit_note_journal_entry',
          },
        })
      }
    }

    const warnings: Array<{ code: string; message: string }> = []
    if (journalEntryId) {
      const { error: linkError } = await supabase
        .from('supplier_invoices')
        .update({ registration_journal_entry_id: journalEntryId })
        .eq('id', creditNote.id)
        .eq('company_id', companyId)
      if (linkError) {
        opLog.error('credit note voucher link failed', linkError as Error, { journalEntryId })
        warnings.push({ code: 'JOURNAL_ENTRY_LINK_FAILED', message: 'Kreditnotan är bokförd men verifikationen kunde inte kopplas till den.' })
      }
    }

    const newRemaining = Math.max(0, roundOre(original.remaining_amount - original.total))
    const newStatus = newRemaining <= 0 ? 'credited' : original.status

    // Guarded on the original's state as read above: a concurrent payment or
    // credit changes it, and this update must then not overwrite that.
    const { data: flipped, error: flipError } = await supabase
      .from('supplier_invoices')
      .update({
        status: newStatus,
        remaining_amount: newRemaining,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', original.status)
      .eq('remaining_amount', original.remaining_amount)
      .select('id')
    if (flipError || !flipped || flipped.length === 0) {
      opLog.error('original supplier invoice not updated after credit', (flipError ?? new Error('0 rows')) as Error)
      warnings.push({
        code: 'ORIGINAL_STATUS_NOT_UPDATED',
        message: 'Kreditnotan är bokförd, men leverantörsfakturans status/restbelopp kunde inte uppdateras. Kontrollera fakturan.',
      })
    }

    try {
      await eventBus.emit({
        type: 'supplier_invoice.credited',
        payload: {
          supplierInvoice: original as SupplierInvoice,
          creditNote: creditNote as SupplierInvoice,
          companyId: companyId!,
          userId: user.id,
        },
      })
    } catch (err) {
      opLog.warn('supplier_invoice.credited event emission failed', err as Error)
    }

    return NextResponse.json({
      data: creditNote,
      journal_entry_id: journalEntryId,
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  },
  { requireWrite: true },
)
