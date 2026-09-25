import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireWritePermission } from '@/lib/auth/require-write'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'
import { planReversalJournal, translateStornoRpcError } from '@/lib/bookkeeping/storno-plan'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'
import { eventBus } from '@/lib/events'
import type { JournalEntry, JournalEntryLine } from '@/types'

ensureInitialized()

/**
 * Create a correction for a booked salary run.
 *
 * Per BFL 5 kap 5§ (Rättelse): corrections preserve the original. In ONE
 * database transaction (correct_salary_run):
 *   1. Storno of every voucher of the original run (reverse_journal_entry_v2)
 *   2. The original run is marked 'corrected'
 *   3. A new draft correction run for the same period, with every employee
 *      and line item copied, ready to be edited and re-calculated
 *
 * Either all of it happens or none of it. AGI must be re-generated for the
 * period (the correction replaces the individuppgifter).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.runs.correct',
  async (_request, ctx, { params }) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const { id } = await params

    const writeCheck = await requireWritePermission(supabase, user.id)
    if (!writeCheck.ok) return writeCheck.response

    const { data: originalRun, error: runError } = await supabase
      .from('salary_runs')
      .select('id, status, salary_entry_id, avgifter_entry_id, vacation_entry_id, pension_entry_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'booked')
      .maybeSingle()

    if (runError || !originalRun) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        status: 400,
        messageSv: 'Kan bara korrigera bokförda lönekörningar.',
      })
    }

    const entryIds = [
      originalRun.salary_entry_id,
      originalRun.avgifter_entry_id,
      originalRun.vacation_entry_id,
      originalRun.pension_entry_id,
    ].filter(Boolean) as string[]

    const { data: entries, error: entriesError } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('company_id', companyId)
      .in('id', entryIds)
    if (entriesError) return errorResponse(entriesError, log, { requestId })

    const reversalDate = getSwedishLocalDate()
    const plans: Record<string, unknown> = {}
    for (const entry of (entries ?? []) as JournalEntry[]) {
      if (entry.status !== 'posted') continue
      plans[entry.id] = planReversalJournal(entry, (entry.lines ?? []) as JournalEntryLine[], reversalDate)
    }

    const { data, error } = await createServiceClient().rpc('correct_salary_run', {
      p_company_id: companyId,
      p_actor_user_id: user.id,
      p_run_id: id,
      p_reversal_plans: plans,
      p_reversal_date: reversalDate,
    })

    if (error) {
      if (error.code === '23505') {
        return errorResponseFromCode('CONFLICT', log, {
          requestId,
          messageSv: 'Det finns redan en aktiv lönekörning för denna period. Ta bort den först.',
        })
      }
      if (error.code === '55000') {
        return errorResponseFromCode('CONFLICT', log, {
          requestId,
          messageSv: 'Lönekörningen är inte längre bokförd — den kan redan ha korrigerats.',
        })
      }
      return errorResponse(translateStornoRpcError(error, 'create_reversal_entry'), log, { requestId })
    }

    const result = data as { correction_run: Record<string, unknown>; reversed_entry_count: number }

    const { data: stornos } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('company_id', companyId)
      .in('reverses_id', entryIds)
    for (const entry of (stornos ?? []) as JournalEntry[]) {
      await eventBus.emit({ type: 'journal_entry.committed', payload: { entry, userId: user.id, companyId } })
    }

    return NextResponse.json({
      data: result.correction_run,
      message: 'Korrigeringskörning skapad. Originalverifikationer har makulerats (storno). Redigera och beräkna om den nya körningen.',
      reversed_entry_count: result.reversed_entry_count,
    }, { status: 201 })
  },
)
