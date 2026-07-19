import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { roundOre, ORE_TOLERANCE } from '@/lib/bokslut/rounding'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { findNextPeriod } from './period-service'
import {
  previewCurrencyRevaluation,
  buildRevaluationRpcPayload,
  computeRevaluationSnapshotKey,
} from '@/lib/bookkeeping/currency-revaluation'
import { getCompanyEntityType } from '@/lib/company/entity-type'
import { validateBalanceContinuity } from '@/lib/reports/continuity-check'
import type {
  YearEndValidation,
  YearEndPreview,
  YearEndResult,
  CreateJournalEntryLineInput,
  FiscalPeriod,
  JournalEntry,
  VoucherGap,
  SequenceMismatch,
} from '@/types'

/**
 * Validate whether a fiscal period is ready for year-end closing.
 * Returns blocking errors and informational warnings.
 */
export async function validateYearEndReadiness(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<YearEndValidation> {
  const errors: string[] = []
  const warnings: string[] = []

  // Fetch the period
  const { data: period, error: fetchError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (fetchError || !period) {
    return {
      ready: false,
      errors: ['Fiscal period not found'],
      warnings: [],
      draftCount: 0,
      voucherGaps: [],
      unexplainedGaps: [],
      sequenceMismatches: [],
      trialBalanceBalanced: false,
    }
  }

  // Check: period must have ended (BFNAR 2017:3 / ÅRL 2:1)
  const today = new Date().toISOString().split('T')[0]
  if (period.period_end > today) {
    errors.push('Cannot close a fiscal period that has not yet ended')
  }

  // Check: period not already closed
  if (period.is_closed) {
    errors.push('Period is already closed')
  }

  // Check: closing entry doesn't already exist
  if (period.closing_entry_id) {
    errors.push('Year-end closing entry already exists for this period')
  }

  // Check: no draft entries. Fails closed (B04): a query error blocks.
  const { count: draftCount, error: draftError } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('status', 'draft')

  if (draftError) {
    errors.push(
      `Kontrollen av utkast till verifikationer kunde inte slutföras (${draftError.message}). Bokslut blockeras tills kontrollen kan köras.`
    )
  }

  const drafts = draftCount ?? 0
  if (drafts > 0) {
    errors.push(`${drafts} draft journal entries must be posted or deleted before closing`)
  }

  // Check: voucher continuity across all series. Fails closed (B04).
  let voucherGaps: VoucherGap[] = []
  const { data: seriesRows, error: seriesError } = await supabase
    .from('voucher_sequences')
    .select('voucher_series')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)

  if (seriesError) {
    errors.push(
      `Verifikationsserierna kunde inte läsas (${seriesError.message}). Bokslut blockeras tills kontrollen kan köras.`
    )
  }

  const seriesToCheck = seriesRows && seriesRows.length > 0
    ? seriesRows.map((r: { voucher_series: string }) => r.voucher_series)
    : ['A']

  for (const series of seriesToCheck) {
    const { data: gaps, error: gapsError } = await supabase.rpc('detect_voucher_gaps', {
      p_company_id: companyId,
      p_fiscal_period_id: fiscalPeriodId,
      p_series: series,
    })

    if (gapsError) {
      // Fail closed (B04): an unverifiable gap check is a blocker, not a pass.
      errors.push(
        `Verifikationsnummerkontrollen för serie ${series} kunde inte slutföras (${gapsError.message}). Bokslut blockeras tills kontrollen kan köras.`
      )
      continue
    }

    if (gaps && gaps.length > 0) {
      const tagged = (gaps as Array<{ gap_start: number; gap_end: number }>).map((g) => ({
        ...g,
        series,
      }))
      voucherGaps.push(...tagged)
    }
  }

  // Check gap explanations — unexplained gaps block year-end (BFNAR 2013:2 punkt 5.8)
  let unexplainedGaps: VoucherGap[] = []
  if (voucherGaps.length > 0) {
    const { data: explanations } = await supabase
      .from('voucher_gap_explanations')
      .select('voucher_series, gap_start, gap_end')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', fiscalPeriodId)

    const explanationSet = new Set(
      (explanations ?? []).map(
        (e: { voucher_series: string; gap_start: number; gap_end: number }) =>
          `${e.voucher_series}:${e.gap_start}:${e.gap_end}`
      )
    )

    for (const gap of voucherGaps) {
      const key = `${gap.series}:${gap.gap_start}:${gap.gap_end}`
      if (explanationSet.has(key)) {
        warnings.push(
          `Voucher gap in series ${gap.series} (${gap.gap_start}-${gap.gap_end}) — documented`
        )
      } else {
        unexplainedGaps.push(gap)
        errors.push(
          `Unexplained voucher gap in series ${gap.series}: ${gap.gap_start}-${gap.gap_end}`
        )
      }
    }
  }

  // Check: sequence counter reconciliation
  const sequenceMismatches: SequenceMismatch[] = []
  if (seriesRows && seriesRows.length > 0) {
    for (const row of seriesRows as Array<{ voucher_series: string }>) {
      const { data: seqData } = await supabase
        .from('voucher_sequences')
        .select('last_number')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('voucher_series', row.voucher_series)
        .single()

      const { data: maxData } = await supabase
        .from('journal_entries')
        .select('voucher_number')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('voucher_series', row.voucher_series)
        .neq('status', 'draft')
        .order('voucher_number', { ascending: false })
        .limit(1)
        .maybeSingle()

      const sequenceCounter = seqData?.last_number ?? 0
      const actualMax = maxData?.voucher_number ?? 0

      if (sequenceCounter !== actualMax) {
        sequenceMismatches.push({
          series: row.voucher_series,
          sequenceCounter,
          actualMax,
        })

        if (sequenceCounter < actualMax) {
          errors.push(
            `Sequence counter integrity error in series ${row.voucher_series}: counter=${sequenceCounter} but max voucher=${actualMax}`
          )
        } else {
          warnings.push(
            `Sequence counter ahead of actual entries in series ${row.voucher_series}: counter=${sequenceCounter}, max voucher=${actualMax}`
          )
        }
      }
    }
  }

  // Check: trial balance is balanced
  const trialBalance = await generateTrialBalance(supabase, companyId, fiscalPeriodId)
  const trialBalanceBalanced = trialBalance.isBalanced

  if (!trialBalanceBalanced) {
    errors.push(
      `Trial balance is not balanced: debit=${trialBalance.totalDebit}, credit=${trialBalance.totalCredit}`
    )
  }

  // Check: at least some entries exist
  const { count: entryCount } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('status', 'posted')

  if ((entryCount ?? 0) === 0) {
    warnings.push('No posted journal entries in this period')
  }

  // Check: foreign currency items exist but haven't been revalued
  const { count: revalCount } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('source_type', 'currency_revaluation')
    .eq('status', 'posted')

  if ((revalCount ?? 0) === 0) {
    // Check if there are any open foreign currency items
    const { count: fxReceivables } = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', ['sent', 'overdue'])
      .neq('currency', 'SEK')
      .not('exchange_rate', 'is', null)

    const { count: fxPayables } = await supabase
      .from('supplier_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', ['registered', 'approved', 'overdue', 'partially_paid'])
      .neq('currency', 'SEK')
      .not('exchange_rate', 'is', null)

    if (((fxReceivables ?? 0) + (fxPayables ?? 0)) > 0) {
      warnings.push(
        'Open foreign currency items exist but have not been revalued (ÅRL 4:13)'
      )
    }
  }

  // Check: continuity_verified flag from prior year-end
  if (period.continuity_verified === false) {
    errors.push('Opening balance continuity check failed for this period — resolve discrepancies before closing')
  }

  // Check: next period state. A pre-existing next period (from SIE import,
  // manual creation, or a prior partial run) is fine — we'll reuse it — but
  // one with opening balances already booked blocks closing because we
  // can't post a second IB on top.
  //
  // The period name is not interpolated into the message — although the
  // name is user-supplied at create time and confined to the company,
  // surfacing DB-sourced strings through error paths is the kind of
  // injection footgun we'd rather close at the source than rely on the UI
  // to escape (text rendering and aria-label propagation differ).
  const nextPeriod = await findNextPeriod(supabase, companyId, fiscalPeriodId)
  if (nextPeriod) {
    if (nextPeriod.opening_balance_entry_id) {
      errors.push('Next fiscal period already has opening balances posted')
    } else {
      warnings.push('Next fiscal period already exists — opening balances will be booked into it')
    }
  }

  return {
    ready: errors.length === 0,
    errors,
    warnings,
    draftCount: drafts,
    voucherGaps,
    unexplainedGaps,
    sequenceMismatches,
    trialBalanceBalanced,
  }
}

/**
 * Preview year-end closing without persisting anything.
 * Shows the net result, closing account, and the journal entry lines that would be created.
 */
export async function previewYearEndClosing(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string
): Promise<YearEndPreview> {

  // Canonical legal form (B13) — companies.entity_type, no silent AB fallback.
  const entityType = await getCompanyEntityType(supabase, companyId)
  const closingAccount = entityType === 'enskild_firma' ? '2010' : '2099'
  const closingAccountName =
    entityType === 'enskild_firma'
      ? 'Eget kapital'
      : 'Årets resultat'

  // Get income statement for net result
  const incomeStatement = await generateIncomeStatement(supabase, companyId, fiscalPeriodId)
  const netResult = incomeStatement.net_result

  // Get trial balance for individual account balances in class 3-8
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId)
  const resultAccounts = rows.filter(
    (r) => r.account_class >= 3 && r.account_class <= 8
  )

  // Build closing lines: zero each result account
  const closingLines: CreateJournalEntryLineInput[] = []
  const resultAccountSummary: { account_number: string; account_name: string; amount: number }[] = []

  for (const account of resultAccounts) {
    const netBalance = account.closing_debit - account.closing_credit

    if (Math.abs(netBalance) < ORE_TOLERANCE) continue

    resultAccountSummary.push({
      account_number: account.account_number,
      account_name: account.account_name,
      amount: netBalance,
    })

    // To zero this account: reverse its net balance
    if (netBalance > 0) {
      // Account has debit balance → credit it to zero
      closingLines.push({
        account_number: account.account_number,
        debit_amount: 0,
        credit_amount: roundOre(netBalance),
        line_description: `Closing: ${account.account_name}`,
      })
    } else {
      // Account has credit balance → debit it to zero
      closingLines.push({
        account_number: account.account_number,
        debit_amount: roundOre(Math.abs(netBalance)),
        credit_amount: 0,
        line_description: `Closing: ${account.account_name}`,
      })
    }
  }

  // Final line: transfer net result to closing account (2099/2010)
  // Net result = revenue - expenses + financial
  // If positive (profit): credit to equity (2099/2010)
  // If negative (loss): debit to equity (2099/2010)
  const totalClosingDebit = closingLines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalClosingCredit = closingLines.reduce((sum, l) => sum + l.credit_amount, 0)
  const balancingAmount = roundOre(Math.abs(totalClosingDebit - totalClosingCredit))

  if (balancingAmount > ORE_TOLERANCE) {
    if (totalClosingDebit > totalClosingCredit) {
      // More debits than credits → need credit on closing account
      closingLines.push({
        account_number: closingAccount,
        debit_amount: 0,
        credit_amount: balancingAmount,
        line_description: `Årets resultat → ${closingAccountName}`,
      })
    } else {
      // More credits than debits → need debit on closing account
      closingLines.push({
        account_number: closingAccount,
        debit_amount: balancingAmount,
        credit_amount: 0,
        line_description: `Årets resultat → ${closingAccountName}`,
      })
    }
  }

  // Fetch fiscal period for closing date
  const { data: periodData } = await supabase
    .from('fiscal_periods')
    .select('period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  let currencyRevaluation = null
  if (periodData) {
    const revalPreview = await previewCurrencyRevaluation(
      supabase,
      companyId,
      periodData.period_end
    )
    if (revalPreview.items.length > 0) {
      currencyRevaluation = revalPreview
    }
  }

  return {
    netResult,
    closingAccount,
    closingAccountName,
    closingLines,
    resultAccountSummary,
    currencyRevaluation,
  }
}

/**
 * Execute year-end closing for a fiscal period — ATOMIC (B01, B02, B09).
 *
 * The entire close (in-transaction readiness re-check, currency revaluation,
 * closing entry, period lock+close, next-period resolution, opening balances,
 * deterministic FX reversal in the next period, exact continuity check) runs
 * inside ONE database transaction via the execute_year_end_closing RPC,
 * serialized by an advisory lock. The close ends in exactly one of two
 * states: fully open (rolled back) or fully closed.
 *
 * Idempotency (B09): the default idempotency key is deterministic per
 * period, so a retry after a timeout replays the completed run instead of
 * creating duplicates. Failed attempts are recorded in year_end_runs so the
 * UI can show and recover from them (B10).
 */
export async function executeYearEndClosing(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  options?: { idempotencyKey?: string }
): Promise<YearEndResult> {
  const idempotencyKey = options?.idempotencyKey ?? `close:${fiscalPeriodId}`

  // Fetch the period for the balance date. The RPC re-validates everything
  // inside its locked transaction (B03) — this fetch only feeds the FX
  // preview computation.
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    throw new Error('Fiscal period not found')
  }

  // Compute the currency revaluation underlag (historical open items as of
  // the balance date, B06/B07) and its deterministic snapshot key (B05).
  // Rates come from Riksbanken; the RPC persists the snapshot and posts the
  // entry inside the same transaction as the close (B01).
  const revalPreview = await previewCurrencyRevaluation(
    supabase,
    companyId,
    period.period_end
  )
  const revaluationPayload =
    revalPreview.items.length > 0
      ? buildRevaluationRpcPayload(companyId, period.period_end, revalPreview)
      : {
          balance_date: period.period_end,
          snapshot_key: computeRevaluationSnapshotKey(companyId, period.period_end, []),
          lines: [],
          items: [],
        }

  const { data: rpcResult, error: rpcError } = await supabase.rpc('execute_year_end_closing', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_revaluation: revaluationPayload,
  })

  if (rpcError) {
    // Record the failed attempt for visibility/recovery (B10). Best-effort:
    // the failure itself is the primary signal.
    try {
      await supabase.from('year_end_runs').insert({
        company_id: companyId,
        fiscal_period_id: fiscalPeriodId,
        status: 'failed',
        idempotency_key: idempotencyKey,
        error_message: rpcError.message.slice(0, 2000),
        created_by: userId,
        finished_at: new Date().toISOString(),
      })
    } catch {
      // swallow — the thrown error below carries the diagnostic
    }
    throw new Error(`Year-end closing failed: ${rpcError.message}`)
  }

  const result = rpcResult as {
    run_id: string
    closing_entry_id: string
    opening_balance_entry_id: string
    next_period_id: string
    revaluation_entry_id: string | null
    revaluation_reversal_entry_id: string | null
    idempotent: boolean
  }

  // Assemble the YearEndResult from the committed state.
  const [closingEntryRes, obEntryRes, nextPeriodRes, revalEntryRes] = await Promise.all([
    supabase
      .from('journal_entries')
      .select('*')
      .eq('id', result.closing_entry_id)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('journal_entries')
      .select('*')
      .eq('id', result.opening_balance_entry_id)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('fiscal_periods')
      .select('*')
      .eq('id', result.next_period_id)
      .eq('company_id', companyId)
      .single(),
    result.revaluation_entry_id
      ? supabase
          .from('journal_entries')
          .select('*')
          .eq('id', result.revaluation_entry_id)
          .eq('company_id', companyId)
          .single()
      : Promise.resolve({ data: null, error: null }),
  ])

  if (closingEntryRes.error || !closingEntryRes.data) {
    throw new Error('Year-end closed but the closing entry could not be fetched')
  }
  if (obEntryRes.error || !obEntryRes.data) {
    throw new Error('Year-end closed but the opening balance entry could not be fetched')
  }
  if (nextPeriodRes.error || !nextPeriodRes.data) {
    throw new Error('Year-end closed but the next period could not be fetched')
  }

  // Independent continuity verification for the result payload. The RPC
  // already enforced exactness inside the transaction.
  const continuity = await validateBalanceContinuity(
    supabase,
    companyId,
    result.next_period_id
  )

  // Fetch the now-closed period for the event payload
  const { data: closedPeriod } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (closedPeriod && !result.idempotent) {
    await eventBus.emit({
      type: 'period.year_closed',
      payload: { period: closedPeriod as FiscalPeriod, companyId, userId },
    })
  }

  return {
    closingEntry: closingEntryRes.data as JournalEntry,
    nextPeriod: nextPeriodRes.data as FiscalPeriod,
    openingBalanceEntry: obEntryRes.data as JournalEntry,
    revaluationEntry: (revalEntryRes.data as JournalEntry | null) ?? null,
    continuity,
  }
}

/**
 * Generate opening balance entries in the next period from the closed period's
 * balance sheet accounts (class 1-2).
 *
 * Each account's closing balance becomes its opening balance.
 * The entry must be balanced (total debit openings = total credit openings).
 */
export async function generateOpeningBalances(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  closedPeriodId: string,
  nextPeriodId: string
): Promise<JournalEntry> {

  // Get next period for the entry date
  const { data: nextPeriod } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', nextPeriodId)
    .eq('company_id', companyId)
    .single()

  if (!nextPeriod) {
    throw new Error('Next fiscal period not found')
  }

  // Get trial balance of closed period (includes the closing entry)
  const { rows } = await generateTrialBalance(supabase, companyId, closedPeriodId)

  // Filter to balance sheet accounts (class 1-2) with non-zero closing balance
  const balanceSheetAccounts = rows.filter(
    (r) => r.account_class >= 1 && r.account_class <= 2
  )

  const openingLines: CreateJournalEntryLineInput[] = []

  for (const account of balanceSheetAccounts) {
    const netBalance = account.closing_debit - account.closing_credit

    if (Math.abs(netBalance) < ORE_TOLERANCE) continue

    if (netBalance > 0) {
      // Debit balance → opening debit
      openingLines.push({
        account_number: account.account_number,
        debit_amount: roundOre(netBalance),
        credit_amount: 0,
        line_description: `Ingående balans: ${account.account_name}`,
      })
    } else {
      // Credit balance → opening credit
      openingLines.push({
        account_number: account.account_number,
        debit_amount: 0,
        credit_amount: roundOre(Math.abs(netBalance)),
        line_description: `Ingående balans: ${account.account_name}`,
      })
    }
  }

  if (openingLines.length === 0) {
    throw new Error('No balance sheet accounts with non-zero closing balance')
  }

  // Verify balance before creating
  const totalDebit = openingLines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredit = openingLines.reduce((sum, l) => sum + l.credit_amount, 0)

  if (Math.abs(totalDebit - totalCredit) > ORE_TOLERANCE) {
    throw new Error(
      `Ingående balanser balanserar inte: debet=${roundOre(totalDebit)}, kredit=${roundOre(totalCredit)}`
    )
  }

  // Create opening balance entry in next period
  const openingEntry = await createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: nextPeriodId,
    entry_date: nextPeriod.period_start,
    description: `Ingående balans ${nextPeriod.name}`,
    source_type: 'opening_balance',
    voucher_series: 'A',
    lines: openingLines,
  })

  // Mark next period with opening balance entry
  const { error: updateError } = await supabase
    .from('fiscal_periods')
    .update({
      opening_balance_entry_id: openingEntry.id,
      opening_balances_set: true,
    })
    .eq('id', nextPeriodId)
    .eq('company_id', companyId)

  if (updateError) {
    throw new Error(`Failed to set opening_balance_entry_id: ${updateError.message}`)
  }

  return openingEntry
}

