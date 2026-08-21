import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { requireWritePermission } from '@/lib/auth/require-write'
import { ensureInitialized } from '@/lib/init'
import { eventBus } from '@/lib/events/bus'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createLogger } from '@/lib/logger'
import { syncInvoiceStatusFromPaymentEntry } from '@/lib/bookkeeping/payment-sync'

const logger = createLogger('journal-entries')

ensureInitialized()

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entries.get',
  async (_request, ctx, { params }) => {
    const { supabase, companyId } = ctx
    const { id } = await params



    const { data, error } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }

    return NextResponse.json({ data })
  },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal_entries.delete',
  async (_request, ctx, { params }) => {
    const { supabase, companyId, user } = ctx
    const { id } = await params


    const writeCheck = await requireWritePermission(supabase, user.id)
    if (!writeCheck.ok) return writeCheck.response


    // Read source_type/source_id BEFORE deleting so we can revert the linked
    // invoice/supplier_invoice status afterwards. The GL row gets cancelled by
    // delete_last_voucher but the invoice's paid status lives outside the GL
    // and would otherwise stay stuck on "paid" after the user deletes the
    // payment voucher.
    const { data: entryBefore } = await supabase
      .from('journal_entries')
      .select('id, source_type, source_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    const { data, error } = await supabase.rpc('delete_last_voucher', {
      p_company_id: companyId,
      p_entry_id: id,
    })

    if (error) {
      logger.error('delete_last_voucher failed', { entryId: id, error })
      return NextResponse.json(
        { error: getErrorMessage(error, { context: 'journal_entry', statusCode: 400 }) },
        { status: 400 }
      )
    }

    if (entryBefore) {
      try {
        await syncInvoiceStatusFromPaymentEntry(supabase, companyId, entryBefore)
      } catch (syncError) {
        logger.warn('payment status sync failed after delete', { entryId: id, error: syncError })
      }
    }

    await eventBus.emit({
      type: 'journal_entry.deleted',
      payload: {
        entryId: id,
        voucherSeries: data.voucher_series,
        voucherNumber: data.voucher_number,
        userId: user.id,
        companyId,
      },
    })

    return NextResponse.json({ data })
  },
)
