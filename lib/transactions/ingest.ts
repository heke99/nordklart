import type { SupabaseClient } from '@supabase/supabase-js'
import { matchTransactionToPayments } from '@/lib/payments/payment-matching-service'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { contentBucketKey, descriptionsBridge, normalizeImportedDescription } from '@/lib/transactions/external-id'
import {
  loadAutomationSettings,
  processBankTransactionAutomation,
  type CompanyAutomationSettings,
  type CustomerInvoiceMatchInput,
  type SupplierInvoiceMatchInput,
} from '@/lib/automation/bank-transaction-automation'
import { checkSieOverlapForDates } from '@/lib/automation/sie-overlap'
import type { Transaction, RawTransaction, IngestResult, IngestRowResult, IngestOptions, SupplierInvoice, Currency, ExchangeRate } from '@/types'

// Re-export types for backward compatibility
export type { RawTransaction, IngestResult } from '@/types'

/**
 * One existing row in a content-dedup bucket: its normalized/lowercased
 * description plus the cash account it settled on (null for legacy rows that
 * predate the cash_account_id backfill). `cashAccountId` is the cross-account
 * guard — see `consumeBridgingTwin`.
 */
type BucketEntry = { desc: string; cashAccountId: string | null }

/**
 * Content-dedup bucket: a `{date}|{öre}` key mapped to the multiset of existing
 * rows in that bucket. Matching is by `descriptionsBridge` (prefix-containment)
 * gated by the account guard, consumed with COUNTING semantics — one entry is
 * spliced out per deduped incoming row — so two genuinely-distinct
 * same-(date,amount) transactions are never collapsed.
 */
type DescBucket = Map<string, BucketEntry[]>

interface ExistingTransactionMaps {
  /** Booked transactions (any source) — consumed by any incoming raw transaction. */
  booked: DescBucket
  /**
   * Unbooked enable_banking transactions — consumed by any incoming raw
   * transaction regardless of source. Catches two cases: PSD2 reconnect
   * duplicates (external_id regenerated, same tx already pending) AND
   * CSV imports overlapping an active PSD2 sync (same Lunar/etc tx arriving
   * twice, once via PSD2 and once via file upload).
   */
  unbookedEnableBanking: DescBucket
}

/** Push a row into its (date, öre) bucket, normalizing the description. */
function addToBucket(
  bucket: DescBucket,
  date: string,
  amount: number | string,
  description: string,
  cashAccountId: string | null,
): void {
  const key = contentBucketKey(date, amount)
  const entry: BucketEntry = { desc: description.toLowerCase().trim(), cashAccountId }
  const entries = bucket.get(key)
  if (entries) entries.push(entry)
  else bucket.set(key, [entry])
}

async function buildExistingTransactionMaps(
  supabase: SupabaseClient,
  companyId: string,
  rawTransactions: RawTransaction[]
): Promise<ExistingTransactionMaps> {
  const booked: DescBucket = new Map()
  const unbookedEnableBanking: DescBucket = new Map()
  if (rawTransactions.length === 0) return { booked, unbookedEnableBanking }

  const dates = rawTransactions.map((t) => t.date).sort()
  const dateFrom = dates[0]
  const dateTo = dates[dates.length - 1]

  {
    // Fail closed (K06): a dedup query error must never be interpreted as
    // "no duplicates" — paginated so large histories are fully covered.
    const bookedRows = await fetchAllRows<{
      date: string
      amount: number
      original_description: string | null
      description: string
      cash_account_id: string | null
    }>(({ from, to }) =>
      supabase
        .from('transactions')
        .select('date, amount, original_description, description, cash_account_id')
        .eq('company_id', companyId)
        .not('journal_entry_id', 'is', null)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .order('id', { ascending: true })
        .range(from, to)
    ).catch((err: Error) => {
      throw new Error(`Dubblettkontrollen kunde inte slutföras (bokförda transaktioner): ${err.message}`)
    })

    if (bookedRows) {
      for (const tx of bookedRows) {
        // Key off the immutable bank original, not the user-editable
        // description: a title edit must never make the dedup bridge miss a
        // genuine re-import. Falls back to description for rows predating the
        // original_description column.
        addToBucket(
          booked,
          tx.date,
          tx.amount,
          normalizeImportedDescription(tx.original_description ?? tx.description),
          tx.cash_account_id ?? null,
        )
      }
    }
  }

  {
    const unbookedBank = await fetchAllRows<{
      date: string
      amount: number
      original_description: string | null
      description: string
      cash_account_id: string | null
    }>(({ from, to }) =>
      supabase
        .from('transactions')
        .select('date, amount, original_description, description, cash_account_id')
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .eq('import_source', 'enable_banking')
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .order('id', { ascending: true })
        .range(from, to)
    ).catch((err: Error) => {
      throw new Error(`Dubblettkontrollen kunde inte slutföras (obokförda banktransaktioner): ${err.message}`)
    })

    if (unbookedBank) {
      for (const tx of unbookedBank) {
        // See booked-map note: dedup on the immutable bank original so a
        // user title edit cannot reopen the duplicate-import window.
        addToBucket(
          unbookedEnableBanking,
          tx.date,
          tx.amount,
          normalizeImportedDescription(tx.original_description ?? tx.description),
          tx.cash_account_id ?? null,
        )
      }
    }
  }

  return { booked, unbookedEnableBanking }
}

/**
 * Generic transaction ingestion pipeline.
 *
 * Handles:
 * 1. Deduplication via external_id
 * 1b. Content-based dedup (date+amount+description prefix) against already-booked
 *     transactions — catches cross-source duplicates, e.g. PSD2 row gets booked
 *     before the user later re-imports the same period via CSV.
 * 1c. Content-based dedup against unbooked enable_banking rows — catches PSD2
 *     reconnect duplicates AND CSV imports overlapping an active PSD2 sync (the
 *     description-prefix component makes this safe to apply across sources).
 * 2. Insert into transactions table
 * 3. OCR/reference-based invoice matching (highest confidence)
 * 4. Amount+customer fallback invoice matching
 * 5. Mapping rule evaluation for auto-categorization
 * 6. Auto-journal-entry creation for high-confidence matches
 *
 * Used by both bank file import and Enable Banking PSD2 sync.
 */
export async function ingestTransactions(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  rawTransactions: RawTransaction[],
  options?: IngestOptions
): Promise<IngestResult> {
  const result: IngestResult = {
    imported: 0,
    duplicates: 0,
    reconciled: 0,
    auto_categorized: 0,
    auto_matched_invoices: 0,
    errors: 0,
    transaction_ids: [],
    automation_errors: 0,
    mapping_required: 0,
    row_results: [],
  }

  // Pre-fetch existing transactions for content-based dedup
  // (date+amount+description prefix). Booked rows catch cross-source
  // duplicates after they've been booked; unbooked enable_banking rows
  // catch the more common case where a PSD2 row is still pending in the
  // inbox when the user re-imports the same period via CSV.
  const existingMaps = await buildExistingTransactionMaps(supabase, companyId, rawTransactions)

  // When rawInsertOnly is set (viewer imports), skip pre-fetching supplier
  // invoices and exchange rates — they are not used.
  let unpaidSupplierInvoices: SupplierInvoice[] = []
  // Keyed by `${currency}|${date}` so each non-SEK transaction gets the
  // rate that was valid on its own transaction date, not the import date.
  const exchangeRatesByDate = new Map<string, ExchangeRate>()

  // Company automation posture + SIE-overlap flag, loaded once per batch.
  // Automation replaces the old NODE_ENV-gated auto-booking: what happens to
  // each imported transaction is decided by company_automation_settings, and
  // every decision is recorded in automation_decisions.
  let automationSettings: CompanyAutomationSettings | null = null
  let sieOverlap = false
  if (!options?.rawInsertOnly && !options?.disableAutomation && rawTransactions.length > 0) {
    automationSettings = await loadAutomationSettings(supabase, companyId)
    try {
      const overlap = await checkSieOverlapForDates(
        supabase,
        companyId,
        rawTransactions.map((t) => t.date),
      )
      sieOverlap = overlap.overlaps
    } catch {
      // Fail safe — treat as overlapping so nothing auto-books.
      sieOverlap = true
    }
  }

  if (!options?.rawInsertOnly) {
  // Pre-fetch unpaid supplier invoices for expense matching (non-critical)
  try {
    unpaidSupplierInvoices = await fetchAllRows<SupplierInvoice>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('*, supplier:suppliers(*)')
        .eq('company_id', companyId)
        .in('status', ['registered', 'approved'])
        .gt('remaining_amount', 0)
        .range(from, to)
    )
  } catch {
    // Non-critical — supplier invoice matching will be skipped
  }
  }

  // Pre-fetch exchange rates for each unique (currency, date) pair in the
  // batch. Riksbanken publishes a per-day rate; using one batched fetch with
  // no date stamps every row at today's rate, which is wrong for historical
  // imports (issue #442). fetchExchangeRate already falls back to the last
  // 7 days when the requested day is a weekend/holiday.
  if (!options?.rawInsertOnly) {
    const uniquePairs = new Map<string, { currency: Currency; date: string }>()
    for (const t of rawTransactions) {
      if (t.currency && t.currency !== 'SEK' && t.date) {
        const key = `${t.currency}|${t.date}`
        if (!uniquePairs.has(key)) {
          uniquePairs.set(key, { currency: t.currency as Currency, date: t.date })
        }
      }
    }

    if (uniquePairs.size > 0) {
      const pairs = Array.from(uniquePairs.entries())
      const settled = await Promise.allSettled(
        pairs.map(([, { currency, date }]) =>
          fetchExchangeRate(currency, new Date(date))
        )
      )
      for (let i = 0; i < pairs.length; i++) {
        const [key] = pairs[i]
        const outcome = settled[i]
        if (outcome.status === 'fulfilled' && outcome.value) {
          exchangeRatesByDate.set(key, outcome.value)
        }
        // Network failures resolve inside fetchExchangeRate to getFallbackRate()
        // (non-null, today's date), so they still populate the key. The key
        // only stays unset when the API returns an empty observation array
        // or the promise rejects outright — in that case amount_sek and
        // exchange_rate remain null on the inserted transaction.
      }
    }
  }

  // Pre-fetch existing external_ids in batches for dedup (avoids N+1 queries)
  const existingExternalIds = new Set<string>()
  const externalIds = rawTransactions.map(t => t.external_id)
  for (let i = 0; i < externalIds.length; i += 500) {
    const chunk = externalIds.slice(i, i + 500)
    const { data, error: dedupError } = await supabase
      .from('transactions')
      .select('external_id')
      .eq('company_id', companyId)
      .in('external_id', chunk)
    if (dedupError) {
      // Fail closed (K06): a failed dedup query must never be read as
      // "no duplicates" — the (company_id, external_id) unique index is the
      // last line of defense, but we abort before mass-inserting.
      throw new Error(`Dubblettkontrollen kunde inte slutföras: ${dedupError.message}`)
    }
    data?.forEach(r => existingExternalIds.add(r.external_id))
  }

  // Resolve the cash account this batch settled on, once. Every row in one
  // ingest call shares a settlement account: enable-banking calls this per
  // account (settlementAccount = account.ledger_account), CSV import passes the
  // single account the user picked. cash_accounts.ledger_account is unique per
  // company, so this is a single-row lookup. Tolerate a miss — the row stays
  // unbound (cash_account_id NULL) and reconciliation falls back to currency.
  // We never auto-create a cash account here; that would race upsertFromPsd2's
  // seed-promotion logic in lib/cash-accounts/service.ts.
  let cashAccountId: string | null = null
  if (options?.settlementAccount) {
    const { data: ca } = await supabase
      .from('cash_accounts')
      .select('id')
      .eq('company_id', companyId)
      .eq('ledger_account', options.settlementAccount)
      .maybeSingle()
    cashAccountId = (ca?.id as string | undefined) ?? null
  }

  // Track already-matched invoice IDs within this ingestion batch
  // to prevent suggesting the same invoice for multiple transactions
  const matchedInvoiceIds = new Set<string>()
  const matchedSupplierInvoiceIds = new Set<string>()

  for (const raw of rawTransactions) {
    // Normalize the source title once. Guarantees a non-empty, Swedish-first
    // label for every import path (PSD2 sync + all bank-file CSV/CAMT parsers
    // funnel into raw.description) — catching both empty/whitespace titles and
    // the legacy English 'Unknown' sentinel. This normalized value is stored as
    // both description and original_description below; it's what the user sees
    // and edits, and what the content-dedup key is built from.
    const description = normalizeImportedDescription(raw.description)

    // 1. Check for duplicates via external_id (batch pre-fetched)
    if (existingExternalIds.has(raw.external_id)) {
      result.duplicates++
      result.row_results.push({
        external_id: raw.external_id,
        status: 'duplicate',
        transaction_id: null,
        error: null,
      })
      continue
    }

    // 1b/1c. Content-dedup bridge: skip if an existing booked row (any source)
    // OR an unbooked enable_banking row shares this (date, öre) bucket and a
    // *bridging* description (prefix-containment, see descriptionsBridge). This
    // is the net that catches re-imports the external_id check misses — chiefly
    // old-format ids re-synced after the id scheme changed, and PSD2 description
    // enrichment between syncs ("TIC" → "TIC  BG … via internet"). Booked first,
    // then unbooked, preserving the historical 1b-before-1c order.
    //
    // Consumed with COUNTING semantics: each match splices one stored entry out
    // of its bucket, so N stored twins dedup exactly N incoming and two
    // genuinely-distinct same-(date,amount) transactions are kept apart. We
    // consume the LONGEST bridging stored description first so a more-specific
    // twin is matched before a generic one, leaving generic entries for shorter
    // incoming rows.
    //
    // Account guard: when BOTH the incoming batch and a stored entry have a known
    // cash_account_id, they must match — so a transaction on one bank account
    // never deduplicates a genuinely-different one on another account of the same
    // company (the content bucket is company-wide; only external_id embeds the
    // account). A null on either side falls back to bridge-allowed, leaving
    // single-account and legacy (un-backfilled) rows exactly as before.
    //
    // Residual trade-off: within one account, a genuinely-new row whose
    // description is a prefix-extension of an existing same-(date,öre) row can be
    // mis-deduped; it is rare, bounded to the ~90-day PSD2 window where old-format
    // ids still overlap, and the frozen external_id (Layer 1) is the exact dedup
    // going forward — accepted to stop the re-import flood (the inverse, a visible
    // duplicate, was the reported pain).
    const bucketKey = contentBucketKey(raw.date, raw.amount)
    const consumeBridgingTwin = (bucket: DescBucket): boolean => {
      const entries = bucket.get(bucketKey)
      if (!entries || entries.length === 0) return false
      let bestIdx = -1
      let bestLen = -1
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        const sameAccount =
          cashAccountId === null || entry.cashAccountId === null || entry.cashAccountId === cashAccountId
        if (sameAccount && descriptionsBridge(description, entry.desc) && entry.desc.length > bestLen) {
          bestIdx = i
          bestLen = entry.desc.length
        }
      }
      if (bestIdx === -1) return false
      entries.splice(bestIdx, 1)
      return true
    }
    if (
      consumeBridgingTwin(existingMaps.booked) ||
      consumeBridgingTwin(existingMaps.unbookedEnableBanking)
    ) {
      result.duplicates++
      result.row_results.push({
        external_id: raw.external_id,
        status: 'duplicate',
        transaction_id: null,
        error: null,
      })
      continue
    }

    // 2. Insert new transaction (with SEK conversion for foreign currencies)
    const rateInfo = raw.currency && raw.currency !== 'SEK'
      ? exchangeRatesByDate.get(`${raw.currency}|${raw.date}`)
      : undefined
    const amountSek = rateInfo
      ? Math.round(raw.amount * rateInfo.rate * 100) / 100
      : null

    const { data: newTransaction, error: insertError } = await supabase
      .from('transactions')
      .insert({
        company_id: companyId,
        user_id: userId,
        bank_connection_id: raw.bank_connection_id || null,
        cash_account_id: cashAccountId,
        external_id: raw.external_id,
        date: raw.date,
        description: description,
        // Immutable bank/PSD2 original — captured once, never overwritten by a
        // title edit. Equals description at insert; they diverge only if the
        // user later edits the title.
        original_description: description,
        amount: raw.amount,
        currency: raw.currency,
        amount_sek: amountSek,
        exchange_rate: rateInfo?.rate ?? null,
        exchange_rate_date: rateInfo?.date ?? null,
        category: 'uncategorized',
        is_business: null,
        mcc_code: raw.mcc_code || null,
        merchant_name: raw.merchant_name || null,
        reference: raw.reference || null,
        import_source: raw.import_source || null,
        counterparty_iban: raw.counterparty_iban || null,
        counterparty_account: raw.counterparty_account || null,
      })
      .select()
      .single()

    if (insertError || !newTransaction) {
      result.errors++
      result.row_results.push({
        external_id: raw.external_id,
        status: 'error',
        transaction_id: null,
        error: insertError?.message ?? 'insert failed',
      })
      if (!result.first_error && insertError) {
        result.first_error = {
          message: insertError.message,
          code: insertError.code ?? null,
          details: insertError.details ?? null,
          hint: insertError.hint ?? null,
        }
      }
      continue
    }

    result.imported++
    result.transaction_ids.push(newTransaction.id)
    const rowResult: IngestRowResult = {
      external_id: raw.external_id,
      status: 'imported',
      transaction_id: newTransaction.id as string,
      error: null,
    }
    result.row_results.push(rowResult)

    // rawInsertOnly: skip invoice matching, and auto-categorization
    if (options?.rawInsertOnly) continue

    // auto_categorize=false (K01): the import contract says NO automatic
    // categorization or booking — honor it end to end.
    if (options?.disableAutomation) continue

    // Missing cash-account mapping (K07): never auto-book against an
    // arbitrary default account. The transaction stays for manual review
    // with automation_status='needs_review'.
    if (!options?.settlementAccount && raw.import_source === 'enable_banking') {
      result.mapping_required++
      await supabase
        .from('transactions')
        .update({ automation_status: 'needs_review' })
        .eq('id', newTransaction.id)
        .eq('company_id', companyId)
      continue
    }

    // Reconciliation against existing GL lines is intentionally NOT run on
    // import — auto-linking made imported transactions appear "bokförda" to
    // the user without any explicit action. Reconciliation is now a manual
    // operation (BankReconciliationView / runReconciliation / manualLink).

    // 3. Build match candidates via the shared payment-matching service.
    //    Matching itself never writes — what happens with a match (suggest,
    //    pending operation, auto-settle) is decided by the engine under
    //    company_automation_settings.
    let invoiceMatch: CustomerInvoiceMatchInput | null = null
    let supplierMatch: SupplierInvoiceMatchInput | null = null
    let matchAmbiguous = false
    let matchBlockingReasons: string[] = []
    try {
      const matchResult = await matchTransactionToPayments(
        supabase,
        companyId,
        newTransaction as Transaction,
        { unpaidSupplierInvoices, minConfidence: 0.50 },
      )
      matchAmbiguous = matchResult.ambiguous
      // Batch-dedup: skip candidates already consumed by an earlier
      // transaction in this import so one invoice never matches twice.
      const usable = matchResult.candidates.filter((c) =>
        c.candidateType === 'customer_invoice'
          ? !matchedInvoiceIds.has(c.candidateId)
          : !matchedSupplierInvoiceIds.has(c.candidateId),
      )
      const best = usable[0] ?? null
      if (best?.candidateType === 'customer_invoice' && best.invoice) {
        invoiceMatch = {
          invoice: best.invoice,
          confidence: best.score / 100,
          matchReason: best.reasonCodes[0] ?? 'match',
        }
        matchBlockingReasons = best.blockingReasons
      } else if (best?.candidateType === 'supplier_invoice' && best.supplierInvoice) {
        supplierMatch = {
          supplierInvoice: best.supplierInvoice,
          confidence: best.score / 100,
          matchMethod: best.reasonCodes[0] ?? 'match',
        }
        matchBlockingReasons = best.blockingReasons
      }
    } catch {
      // Non-critical — continue processing
    }

    // 4. Controlled automation: candidates → decision → effects.
    //    Replaces the previous NODE_ENV-gated auto-booking. The engine
    //    respects company modes/thresholds, period locks, SIE overlap and the
    //    amount cap; every decision lands in automation_decisions with a
    //    deterministic idempotency key.
    if (automationSettings) {
      try {
        const outcome = await processBankTransactionAutomation(
          supabase,
          companyId,
          userId,
          {
            transaction: newTransaction as Transaction,
            settings: automationSettings,
            sieOverlap,
            settlementAccount: options?.settlementAccount,
            invoiceMatch,
            supplierMatch,
            matchAmbiguous,
            matchBlockingReasons,
            skipAutoCategorization: options?.skipAutoCategorization,
          },
          raw.import_source === 'enable_banking' ? 'bank_sync' : 'bank_import',
        )

        const candidateType = outcome.candidate?.type
        const actedOnMatch =
          outcome.decision === 'suggested' ||
          outcome.decision === 'pending_operation_created' ||
          outcome.decision === 'auto_committed'

        if (candidateType === 'customer_invoice' && actedOnMatch && invoiceMatch) {
          matchedInvoiceIds.add(invoiceMatch.invoice.id)
          result.auto_matched_invoices++
        } else if (candidateType === 'supplier_invoice' && actedOnMatch && supplierMatch) {
          result.auto_matched_invoices++
          if (outcome.decision === 'auto_committed') {
            // Auto-linked — drain the pool so the next transaction cannot
            // match the same supplier invoice. Suggestions stay tentative.
            unpaidSupplierInvoices = unpaidSupplierInvoices.filter(
              inv => inv.id !== supplierMatch!.supplierInvoice.id
            )
            matchedSupplierInvoiceIds.add(supplierMatch.supplierInvoice.id)
          }
        }

        if (
          outcome.journalEntryId &&
          candidateType !== 'customer_invoice' &&
          candidateType !== 'supplier_invoice'
        ) {
          result.auto_categorized++
        }
      } catch (automationErr) {
        // Automation failure must never lose the imported transaction (K16):
        // the row survives, is marked automation_status='failed' for retry,
        // and the sync/import result surfaces the failure.
        result.automation_errors++
        rowResult.automation_failed = true
        try {
          await supabase
            .from('transactions')
            .update({ automation_status: 'failed' })
            .eq('id', newTransaction.id)
            .eq('company_id', companyId)
        } catch {
          // The automation_status stamp is best-effort — the counter above
          // is the authoritative signal.
        }
        void automationErr
      }
    }
  }

  return result
}
