import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { validateBody } from '@/lib/api/validate'
import { BookTransactionSchema } from '@/lib/api/schemas'
import type { Transaction } from '@/types'

ensureInitialized()

export const POST = withRouteContext(
  'transaction.book',
  async (
    request,
    { supabase, companyId, user },
    { params }: { params: Promise<{ id: string }> },
  ) => {
  const { id } = await params

  const validation = await validateBody(request, BookTransactionSchema)
  if (!validation.success) return validation.response
  const { fiscal_period_id, entry_date, description, lines } = validation.data

  // Fetch transaction (validates ownership)
  const { data: transaction, error: fetchError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !transaction) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }

  // Reject if already booked
  if (transaction.journal_entry_id) {
    return NextResponse.json(
      { error: 'Transaction already has a journal entry' },
      { status: 409 }
    )
  }

  // Create journal entry via the engine
  let journalEntry
  try {
    journalEntry = await createJournalEntry(supabase, companyId, user.id, {
      fiscal_period_id,
      entry_date,
      description,
      source_type: 'bank_transaction',
      source_id: id,
      lines,
    })
  } catch (err) {
    const typed = bookkeepingErrorResponse(err)
    if (typed) return typed
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create journal entry' },
      { status: 400 }
    )
  }

  // Link transaction to the journal entry
  const { error: updateError } = await supabase
    .from('transactions')
    .update({
      journal_entry_id: journalEntry.id,
      is_business: true,
      category: 'uncategorized',
    })
    .eq('id', id)

  if (updateError) {
    return NextResponse.json(
      { error: 'Failed to update transaction' },
      { status: 500 }
    )
  }

  // Emit event (non-blocking)
  try {
    await eventBus.emit({
      type: 'transaction.categorized',
      payload: {
        transaction: transaction as Transaction,
        account: lines[0]?.account_number || '',
        taxCode: '',
        userId: user.id,
        companyId,
      },
    })
  } catch {
    // Non-critical
  }

  return NextResponse.json({
    data: journalEntry,
    journal_entry_id: journalEntry.id,
    success: true,
  })
  },
  { requireWrite: true },
)
