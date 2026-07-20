import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchMultipleRates } from '@/lib/currency/riksbanken'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import {
  getHistoricalFxExposure,
  type HistoricalOpenItem,
} from '@/lib/invoices/historical-open-items'
import type {
  Currency,
  RevaluationItem,
  CurrencyRevaluationPreview,
  CurrencyRevaluationResult,
  CreateJournalEntryLineInput,
  JournalEntry,
} from '@/types'
import { roundOre } from '@/lib/money'

/**
 * Currency revaluation (revision items B05–B08, B14).
 *
 * The open exposure is reconstructed AS OF the balance date via the shared
 * historical open-item module (B06): an invoice created after the balance
 * date is excluded; one that was open on the balance date but settled later
 * is revalued with the amount open on the balance date. Partial payments
 * reduce the revalued amount symmetrically for receivables and payables (B07).
 *
 * Persistence is owned by the post_currency_revaluation RPC:
 *   - deterministic snapshot key ⇒ idempotent re-runs (B05),
 *   - changed underlag before close ⇒ controlled replace,
 *   - closed/locked period ⇒ refused,
 *   - the year-end RPC posts the deterministic reversal in the next
 *     period exactly once (B08).
 */


/**
 * Open foreign-currency receivables at `asOfDate` — canonical historical
 * reconstruction shared with readiness/reports (B14).
 */
export async function getOpenForeignCurrencyReceivables(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
): Promise<HistoricalOpenItem[]> {
  const { receivables } = await getHistoricalFxExposure(supabase, companyId, asOfDate)
  return receivables
}

/**
 * Open foreign-currency payables at `asOfDate` — canonical historical
 * reconstruction shared with readiness/reports (B14).
 */
export async function getOpenForeignCurrencyPayables(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate: string,
): Promise<HistoricalOpenItem[]> {
  const { payables } = await getHistoricalFxExposure(supabase, companyId, asOfDate)
  return payables
}

/**
 * Deterministic idempotency key over the full revaluation underlag (B05).
 * Same company, balance date, items and rates ⇒ same key.
 */
export function computeRevaluationSnapshotKey(
  companyId: string,
  closingDate: string,
  items: RevaluationItem[],
): string {
  const canonical = items
    .map((i) => ({
      id: i.source_id,
      t: i.type,
      c: i.currency,
      a: i.amount_in_currency,
      or: i.original_rate,
      cr: i.closing_rate,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return createHash('sha256')
    .update(JSON.stringify({ companyId, closingDate, items: canonical }))
    .digest('hex')
}

/**
 * Preview currency revaluation without persisting.
 * Computes per-item differences and aggregated journal lines.
 *
 * Receivables (1510):
 *   closing > original → gain: Debit 1510, Credit 3960
 *   closing < original → loss: Credit 1510, Debit 7960
 *
 * Payables (2440):
 *   closing > original → loss (liability grew): Debit 7960, Credit 2440
 *   closing < original → gain (liability shrank): Debit 2440, Credit 3960
 */
export async function previewCurrencyRevaluation(
  supabase: SupabaseClient,
  companyId: string,
  closingDate: string
): Promise<CurrencyRevaluationPreview> {
  const { receivables, payables } = await getHistoricalFxExposure(
    supabase,
    companyId,
    closingDate,
  )

  // Collect distinct currencies
  const currencies = new Set<Currency>()
  for (const inv of receivables) {
    currencies.add(inv.currency as Currency)
  }
  for (const si of payables) {
    currencies.add(si.currency as Currency)
  }

  if (currencies.size === 0) {
    return {
      items: [],
      lines: [],
      closingRates: {},
      totalGain: 0,
      totalLoss: 0,
      netEffect: 0,
    }
  }

  // Fetch closing rates
  const rateMap = await fetchMultipleRates(
    Array.from(currencies),
    new Date(closingDate)
  )

  const closingRates: Record<string, number> = {}
  for (const [currency, rate] of rateMap) {
    closingRates[currency] = rate.rate
  }

  const items: RevaluationItem[] = []

  const pushItem = (item: HistoricalOpenItem) => {
    const closingRate = rateMap.get(item.currency as Currency)?.rate
    if (!closingRate || !item.exchange_rate) return

    // Only the amount that was OPEN on the balance date is revalued (B06/B07).
    const amountInCurrency = item.open_amount
    if (amountInCurrency <= 0) return

    const originalSek = roundOre(amountInCurrency * item.exchange_rate)
    const closingSek = roundOre(amountInCurrency * closingRate)
    const difference = roundOre(closingSek - originalSek)

    if (Math.abs(difference) < 0.01) return

    items.push({
      type: item.type === 'invoice' ? 'receivable' : 'payable',
      source_id: item.id,
      reference: item.reference,
      currency: item.currency as Currency,
      amount_in_currency: amountInCurrency,
      original_rate: item.exchange_rate,
      closing_rate: closingRate,
      original_sek: originalSek,
      closing_sek: closingSek,
      difference_sek: difference,
    })
  }

  for (const inv of receivables) pushItem(inv)
  for (const si of payables) pushItem(si)

  // Build aggregated journal lines
  let debit1510 = 0 // Receivable gain (revalue up)
  let credit1510 = 0 // Receivable loss (revalue down)
  let debit2440 = 0 // Payable gain (liability shrank)
  let credit2440 = 0 // Payable loss (liability grew)
  let credit3960 = 0 // Gains
  let debit7960 = 0 // Losses

  for (const item of items) {
    if (item.type === 'receivable') {
      if (item.difference_sek > 0) {
        // Closing > original → gain: Debit 1510, Credit 3960
        debit1510 += item.difference_sek
        credit3960 += item.difference_sek
      } else {
        // Closing < original → loss: Credit 1510, Debit 7960
        credit1510 += Math.abs(item.difference_sek)
        debit7960 += Math.abs(item.difference_sek)
      }
    } else {
      // Payable
      if (item.difference_sek > 0) {
        // Closing > original → loss (liability grew): Debit 7960, Credit 2440
        debit7960 += item.difference_sek
        credit2440 += item.difference_sek
      } else {
        // Closing < original → gain (liability shrank): Debit 2440, Credit 3960
        debit2440 += Math.abs(item.difference_sek)
        credit3960 += Math.abs(item.difference_sek)
      }
    }
  }

  const lines: CreateJournalEntryLineInput[] = []

  if (debit1510 > 0) {
    lines.push({
      account_number: '1510',
      debit_amount: roundOre(debit1510),
      credit_amount: 0,
      line_description: 'Omvärdering kundfordringar — orealiserad kursvinst',
    })
  }
  if (credit1510 > 0) {
    lines.push({
      account_number: '1510',
      debit_amount: 0,
      credit_amount: roundOre(credit1510),
      line_description: 'Omvärdering kundfordringar — orealiserad kursförlust',
    })
  }
  if (debit2440 > 0) {
    lines.push({
      account_number: '2440',
      debit_amount: roundOre(debit2440),
      credit_amount: 0,
      line_description: 'Omvärdering leverantörsskulder — orealiserad kursvinst',
    })
  }
  if (credit2440 > 0) {
    lines.push({
      account_number: '2440',
      debit_amount: 0,
      credit_amount: roundOre(credit2440),
      line_description: 'Omvärdering leverantörsskulder — orealiserad kursförlust',
    })
  }
  if (credit3960 > 0) {
    lines.push({
      account_number: '3960',
      debit_amount: 0,
      credit_amount: roundOre(credit3960),
      line_description: 'Orealiserade valutakursvinster',
    })
  }
  if (debit7960 > 0) {
    lines.push({
      account_number: '7960',
      debit_amount: roundOre(debit7960),
      credit_amount: 0,
      line_description: 'Orealiserade valutakursförluster',
    })
  }

  const totalGain = roundOre(credit3960)
  const totalLoss = roundOre(debit7960)
  const netEffect = roundOre(totalGain - totalLoss)

  return {
    items,
    lines,
    closingRates,
    totalGain,
    totalLoss,
    netEffect,
  }
}

/**
 * The RPC payload for post_currency_revaluation / execute_year_end_closing —
 * lines + per-item snapshot + deterministic idempotency key.
 */
export function buildRevaluationRpcPayload(
  companyId: string,
  closingDate: string,
  preview: CurrencyRevaluationPreview,
): {
  balance_date: string
  snapshot_key: string
  lines: CreateJournalEntryLineInput[]
  items: Array<Record<string, unknown>>
} {
  return {
    balance_date: closingDate,
    snapshot_key: computeRevaluationSnapshotKey(companyId, closingDate, preview.items),
    lines: preview.lines,
    items: preview.items.map((i) => ({
      invoice_id: i.type === 'receivable' ? i.source_id : null,
      supplier_invoice_id: i.type === 'payable' ? i.source_id : null,
      currency: i.currency,
      open_amount_currency: i.amount_in_currency,
      open_amount_sek_original: i.original_sek,
      rate_original: i.original_rate,
      rate_closing: i.closing_rate,
      unrealized_diff_sek: i.difference_sek,
    })),
  }
}

/**
 * Execute currency revaluation for a fiscal period through the idempotent
 * post_currency_revaluation RPC (B05):
 *   - identical underlag → the existing entry is reused (no error, no dupe),
 *   - changed underlag before close → the RPC replaces the old entry,
 *   - closed/locked period → the RPC refuses.
 *
 * Returns null if no foreign-currency exposure exists at the balance date.
 */
export async function executeCurrencyRevaluation(
  supabase: SupabaseClient,
  companyId: string,
  closingDate: string,
  fiscalPeriodId: string,
  userId?: string
): Promise<CurrencyRevaluationResult | null> {
  const preview = await previewCurrencyRevaluation(supabase, companyId, closingDate)

  if (preview.items.length === 0 || preview.lines.length === 0) {
    return null
  }

  const payload = buildRevaluationRpcPayload(companyId, closingDate, preview)

  const { data, error } = await supabase.rpc('post_currency_revaluation', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_user_id: userId ?? null,
    p_balance_date: payload.balance_date,
    p_snapshot_key: payload.snapshot_key,
    p_lines: payload.lines,
    p_items: payload.items,
  })

  if (error) {
    throw new BookkeepingDatabaseError('post_currency_revaluation', error.message)
  }

  const result = data as { run_id: string; entry_id: string | null; reused: boolean }

  let entry: JournalEntry | null = null
  if (result.entry_id) {
    const { data: entryRow, error: entryError } = await supabase
      .from('journal_entries')
      .select('*')
      .eq('id', result.entry_id)
      .eq('company_id', companyId)
      .single()
    if (entryError) {
      throw new BookkeepingDatabaseError('fetch_revaluation_entry', entryError.message)
    }
    entry = entryRow as JournalEntry
  }

  if (!entry) return null

  return { entry, preview }
}
