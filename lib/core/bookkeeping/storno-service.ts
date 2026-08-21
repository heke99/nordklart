import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import type {
  CreateJournalEntryLineInput,
  JournalEntry,
  JournalEntryLine,
} from '@/types'
import { validateBalance } from '@/lib/bookkeeping/engine'
import { roundOre } from '@/lib/money'
import { createServiceClient } from '@/lib/supabase/server'
import {
  planCorrectionJournal,
  planReversalJournal,
  translateStornoRpcError,
} from '@/lib/bookkeeping/storno-plan'
import { resolvePeriodStatusForDate } from '@/lib/core/bookkeeping/period-service'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotCorrectNonPostedError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  JournalEntryNotBalancedError,
  JournalEntryNotFoundError,
  MeaninglessCorrectionError,
  NoOpenPeriodForDateError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
} from '@/lib/bookkeeping/errors'

/**
 * True when every account's (debit − credit) sum across the proposed lines is
 * zero. Such a rättelse describes no real affärshändelse and would erase the
 * original posting without representing anything in its place — disallowed by
 * BFL 5 kap. 5 § / BFNAR 2013:2.
 */
function netsToZeroPerAccount(lines: CreateJournalEntryLineInput[]): boolean {
  const nets = new Map<string, number>()
  for (const line of lines) {
    const delta = roundOre(line.debit_amount || 0) - roundOre(line.credit_amount || 0)
    nets.set(line.account_number, (nets.get(line.account_number) || 0) + delta)
  }
  return Array.from(nets.values()).every((n) => Math.abs(n) < 0.005)
}

/**
 * True when proposed lines are the same multiset as the original lines
 * (account_number + debit + credit). A rättelse must actually change something.
 */
function isIdenticalToOriginal(
  proposed: CreateJournalEntryLineInput[],
  original: JournalEntryLine[]
): boolean {
  if (proposed.length !== original.length) return false
  const key = (acc: string, d: number, c: number) =>
    `${acc}|${roundOre(d).toFixed(2)}|${roundOre(c).toFixed(2)}`
  const proposedKeys = proposed
    .map((l) => key(l.account_number, l.debit_amount || 0, l.credit_amount || 0))
    .sort()
  const originalKeys = original
    .map((l) => key(l.account_number, Number(l.debit_amount) || 0, Number(l.credit_amount) || 0))
    .sort()
  return proposedKeys.every((k, i) => k === originalKeys[i])
}

/**
 * Storno Service - 3-step correction flow per Bokföringslagen
 *
 * Swedish bookkeeping law requires that committed entries cannot be modified.
 * To correct an error, you must:
 * 1. Create a storno (reversal) entry that nullifies the original
 * 2. Create a corrected entry with the right data
 * 3. Link all three via reverses_id, reversed_by_id, correction_of_id
 */

/** Journal entry row fetched together with its lines (the embedded select). */
type OriginalWithLines = JournalEntry & { lines?: JournalEntryLine[] | null }

/**
 * Correct an existing posted journal entry using the storno method.
 *
 * The storno (reversal) is always created in the original entry's period and
 * date, so the original nets to zero where it was booked. The corrected entry
 * defaults to the original's date/period too, but `options.newEntryDate` /
 * `options.newFiscalPeriodId` let a caller re-book it elsewhere — used to move
 * a verifikation booked on the wrong year to its correct period (see
 * recordateEntry). When the date/period is the correction, identical lines are
 * allowed (the move itself is the meaningful change).
 *
 * Returns: { reversal, corrected } - the two new entries created
 */
export async function correctEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  originalEntryId: string,
  correctedLines: CreateJournalEntryLineInput[],
  options?: {
    newEntryDate?: string
    newFiscalPeriodId?: string
    /**
     * The original entry (with lines) already loaded by the caller. When
     * provided, we skip the redundant re-fetch — recordateEntry reads the
     * original to copy its lines and hands it through here. This also closes
     * the small TOCTOU window a second independent read would open.
     */
    preloadedOriginal?: OriginalWithLines
  }
): Promise<{ reversal: JournalEntry; corrected: JournalEntry }> {
  // Validate the corrected lines are balanced
  const balance = validateBalance(correctedLines)
  if (!balance.valid) {
    throw new JournalEntryNotBalancedError(balance.totalDebit, balance.totalCredit, 'correction')
  }

  // Reject a rättelse with no economic effect (e.g. 1930 debit 100 / 1930
  // credit 100). Such an entry would erase the original posting without
  // representing any affärshändelse — disallowed by BFL 5 kap. 5 §.
  if (netsToZeroPerAccount(correctedLines)) {
    throw new MeaninglessCorrectionError('net_zero_per_account')
  }

  // Fetch original entry with lines — unless the caller already loaded it.
  let original = options?.preloadedOriginal ?? null
  if (!original) {
    const { data, error: fetchError } = await supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('id', originalEntryId)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !data) {
      throw new JournalEntryNotFoundError()
    }
    original = data as OriginalWithLines
  }

  if (original.status !== 'posted') {
    throw new CannotCorrectNonPostedError(original.status)
  }

  const originalLines = (original.lines as JournalEntryLine[]) || []

  // Resolve where the corrected entry lands. Defaults to the original's own
  // date/period (a plain line-correction). A caller may override either to
  // re-book the entry in another period (recordate / wrong-year fix).
  const correctedDate = options?.newEntryDate ?? original.entry_date
  const correctedPeriodId = options?.newFiscalPeriodId ?? original.fiscal_period_id
  const dateOrPeriodChanged =
    correctedDate !== original.entry_date || correctedPeriodId !== original.fiscal_period_id

  // Reject when the proposed lines are identical to the original entry — a
  // rättelse must actually change something. Skip this when the date/period is
  // the change (moving a verifikation to the right year keeps the same lines).
  if (!dateOrPeriodChanged && isIdenticalToOriginal(correctedLines, originalLines)) {
    throw new MeaninglessCorrectionError('identical_to_original')
  }

  // When re-booking elsewhere, validate the corrected date falls within the
  // target period's bounds (mirrors createDraftEntry). recordateEntry resolves
  // the period from the date, so this also guards a mismatched explicit
  // override and fails fast before any storno is written.
  if (dateOrPeriodChanged) {
    const { data: targetPeriod, error: targetErr } = await supabase
      .from('fiscal_periods')
      .select('name, period_start, period_end')
      .eq('id', correctedPeriodId)
      .eq('company_id', companyId)
      .single()
    if (targetErr || !targetPeriod) {
      throw new FiscalPeriodNotFoundError()
    }
    if (correctedDate < targetPeriod.period_start || correctedDate > targetPeriod.period_end) {
      throw new EntryDateOutsideFiscalPeriodError(
        correctedDate,
        targetPeriod.name,
        targetPeriod.period_start,
        targetPeriod.period_end
      )
    }
  }

  // ===== Storno + rättelse, in one PostgreSQL transaction =====
  //
  // This used to be ~8 separate writes across two entries with compensating
  // cancelEntry() calls between them, and a voucher number allocated up front
  // for each. Both vouchers are now created, linked, committed and the original
  // flipped to 'reversed' inside reverse_journal_entry_v2 — so a rejected
  // rättelse leaves NO voucher behind, not even a cancelled one, and burns no
  // number from the series.

  // The corrected entry may only use accounts that are currently active. (The
  // storno may use inactive ones — those accounts were active when the original
  // was committed, and BFL 5 kap 5 § still requires the reversal to go through.)
  const accountNumbers = [...new Set(correctedLines.map((l) => l.account_number))]
  const { data: activeAccounts } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .in('account_number', accountNumbers)
  const activeSet = new Set((activeAccounts ?? []).map((a) => a.account_number as string))
  const missingAccounts = accountNumbers.filter((num) => !activeSet.has(num))
  if (missingAccounts.length > 0) {
    throw new AccountsNotInChartError(missingAccounts)
  }

  const reversalPlan = planReversalJournal(
    original as JournalEntry,
    originalLines,
    original.entry_date,
  )
  const correctionPlan = planCorrectionJournal(
    original as JournalEntry,
    correctedLines,
    correctedPeriodId,
    correctedDate,
  )

  const service = createServiceClient()
  const { data: rpcResult, error: rpcError } = await service.rpc('reverse_journal_entry_v2', {
    p_company_id: companyId,
    p_actor_user_id: userId,
    p_entry_id: originalEntryId,
    p_reversal_journal: reversalPlan,
    p_reversal_date: original.entry_date,
    p_correction_journal: correctionPlan,
    p_correction_date: correctedDate,
  })

  if (rpcError) {
    throw translateStornoRpcError(rpcError, 'create_corrected_entry')
  }

  const ids = rpcResult as { reversal_entry_id?: string; correction_entry_id?: string } | null
  if (!ids?.reversal_entry_id || !ids.correction_entry_id) {
    throw new BookkeepingDatabaseError(
      'create_corrected_entry',
      'Rättelse-RPC returnerade inte båda verifikaten.',
    )
  }

  // ===== Fetch complete entries =====
  const { data: finalReversal } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', ids.reversal_entry_id)
    .single()

  const { data: finalCorrected } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', ids.correction_entry_id)
    .single()

  const result = {
    reversal: finalReversal as JournalEntry,
    corrected: finalCorrected as JournalEntry,
  }

  await eventBus.emit({
    type: 'journal_entry.corrected',
    payload: {
      original: original as JournalEntry,
      storno: result.reversal,
      corrected: result.corrected,
      companyId,
      userId,
    },
  })

  return result
}

/**
 * Move a posted verifikation to a different date — and thereby a different
 * fiscal period — without changing its lines. Fixes a booking entered with the
 * wrong date/year (e.g. 2026-07-03 that should have been 2025-07-03).
 *
 * A posted verifikation is immutable (BFL), so this is a storno + re-book under
 * the hood: the original is reversed in its own period (netting it to zero
 * there) and an identical corrected verifikation is posted with `newDate` in
 * the target period. The underlag follows the corrected entry. The full chain
 * original → storno → correction stays linked (BFL 5 kap. 5 §).
 *
 * Fails fast with a typed error if the target date is not bookable: closed year
 * (TargetPeriodClosedError), locked period / company lock date
 * (TargetPeriodLockedError), or no covering period (NoOpenPeriodForDateError).
 */
export async function recordateEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  originalEntryId: string,
  newDate: string
): Promise<{ reversal: JournalEntry; corrected: JournalEntry }> {
  // Fetch original with lines
  const { data: original, error: fetchError } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', originalEntryId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !original) {
    throw new JournalEntryNotFoundError()
  }
  if (original.status !== 'posted') {
    throw new CannotCorrectNonPostedError(original.status)
  }
  if (newDate === original.entry_date) {
    throw new MeaninglessCorrectionError('no_date_change')
  }

  // Classify the target date using the same two-layer logic the DB triggers
  // enforce (company lock date + period is_closed/locked_at), so we surface a
  // clear Swedish message instead of a raw trigger rejection.
  const target = await resolvePeriodStatusForDate(supabase, companyId, newDate)
  if (target.status === 'closed') {
    throw new TargetPeriodClosedError(newDate)
  }
  if (target.status === 'locked') {
    throw new TargetPeriodLockedError(newDate, target.lock_date)
  }
  if (!target.period_id) {
    // 'open' but no covering period — we do not auto-create periods on a fix.
    throw new NoOpenPeriodForDateError(newDate)
  }

  // Copy the original lines verbatim — they were correct; only the date was
  // wrong. correctEntry rebuilds the storno from the original anyway.
  const originalLines = (original.lines as JournalEntryLine[]) || []
  const copiedLines: CreateJournalEntryLineInput[] = originalLines
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((line) => ({
      account_number: line.account_number,
      debit_amount: Number(line.debit_amount) || 0,
      credit_amount: Number(line.credit_amount) || 0,
      line_description: line.line_description || undefined,
      currency: line.currency || undefined,
      amount_in_currency:
        line.amount_in_currency != null ? Number(line.amount_in_currency) : undefined,
      exchange_rate: line.exchange_rate != null ? Number(line.exchange_rate) : undefined,
      tax_code: line.tax_code || undefined,
      cost_center: line.cost_center || undefined,
      project: line.project || undefined,
    }))

  const result = await correctEntry(
    supabase,
    companyId,
    userId,
    originalEntryId,
    copiedLines,
    {
      newEntryDate: newDate,
      newFiscalPeriodId: target.period_id,
      // Hand the entry we already fetched (with lines) to correctEntry so it
      // doesn't re-read the same row.
      preloadedOriginal: original as OriginalWithLines,
    }
  )

  // Move the underlag to the corrected entry so it doesn't surface as a
  // "verifikat utan underlag" in the target year. Best-effort — the
  // correction_of_id chain preserves traceability even if this fails.
  await relinkDocumentsToEntry(supabase, companyId, originalEntryId, result.corrected.id)

  return result
}

/**
 * Re-point every document_attachment from one entry to another. Used when a
 * verifikation is moved to a different period so its underlag travels with the
 * live (corrected) entry. The line-level link is cleared because the corrected
 * entry has new line ids. Failures are logged, not thrown — the entry-level
 * correction chain is the source of truth for traceability.
 */
async function relinkDocumentsToEntry(
  supabase: SupabaseClient,
  companyId: string,
  fromEntryId: string,
  toEntryId: string
): Promise<void> {
  const { error } = await supabase
    .from('document_attachments')
    .update({ journal_entry_id: toEntryId, journal_entry_line_id: null })
    .eq('company_id', companyId)
    .eq('journal_entry_id', fromEntryId)
  if (error) {
    console.error(
      `[storno] relinkDocumentsToEntry: failed to move documents ${fromEntryId} → ${toEntryId}:`,
      error.message
    )
  }
}
