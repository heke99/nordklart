/**
 * SIE Import Engine
 *
 * Executes the actual import of SIE data into the database.
 * Creates fiscal periods, opening balance entries, and journal entries.
 * All operations are wrapped to ensure atomic behavior.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { commitEntry, createDraftEntry } from '@/lib/bookkeeping/engine'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type {
  ParsedSIEFile,
  AccountMapping,
  ImportResult,
  ImportPreview,
  SIEImport,
  MigrationDocumentation,
} from './types'
import type { CreateJournalEntryLineInput } from '@/types'
import { mappingsToMap, getMappingStats } from './account-mapper'
import { syncMappedAccounts } from './account-sync'
import {
  prepareStagedVouchers,
  stageVouchers,
  buildNextPeriodObLines,
} from './sie-staging'
import { verifySieKsumma } from './sie-ksumma'
import {
  calculateFileHash,
  getEffectiveOpeningBalances,
  isBalanceSheetAccount,
} from './sie-parser'

// Re-export from the parser (moved there to avoid an import cycle —
// getEffectiveOpeningBalances needs it) so existing importers keep working.
export { isBalanceSheetAccount } from './sie-parser'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { classifyAccount } from '@/lib/bookkeeping/account-classifier'
import { computeSRUCode } from '@/lib/bookkeeping/bas-data/sru-mapping'
import { populateTemplatesFromSieVouchers } from '@/lib/bookkeeping/counterparty-templates'
import { parseDateParts } from '@/lib/bookkeeping/validate-period-duration'

/**
 * Format a date to ISO date string (YYYY-MM-DD)
 */
function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Generate a preview of what will be imported
 */
export function generateImportPreview(
  parsed: ParsedSIEFile,
  mappings: AccountMapping[]
): ImportPreview {
  // Calculate opening balance totals from the effective set — for files
  // without #IB 0 this is the IB derived from #UB -1 (issue #675), so the
  // preview (and the IB toggle in ImportReviewStep, keyed off
  // openingBalanceTotal > 0) reflects what the import will actually book.
  const { balances: currentYearBalances, derivedFromPriorYearUB } =
    getEffectiveOpeningBalances(parsed)
  let totalDebit = 0
  let totalCredit = 0

  for (const balance of currentYearBalances) {
    if (balance.amount > 0) {
      totalDebit += balance.amount
    } else {
      totalCredit += Math.abs(balance.amount)
    }
  }

  const mappingStats = getMappingStats(mappings)

  // Dimension registers from #DIM/#OBJEKT — surfaced in the preview so the
  // user sees that cost centers/projects survive the import.
  const dimensions = (parsed.dimensions ?? []).map((dim) => ({
    number: dim.number,
    name: dim.name,
    objectCount: (parsed.objects ?? []).filter((o) => o.dimension === dim.number).length,
  }))

  return {
    companyName: parsed.header.companyName,
    orgNumber: parsed.header.orgNumber,
    fiscalYearStart: parsed.stats.fiscalYearStart,
    fiscalYearEnd: parsed.stats.fiscalYearEnd,
    accountCount: parsed.stats.totalAccounts,
    voucherCount: parsed.stats.totalVouchers,
    transactionLineCount: parsed.stats.totalTransactionLines,
    openingBalanceTotal: totalDebit,
    trialBalance: {
      totalDebit,
      totalCredit,
      isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
    },
    mappingStatus: {
      total: mappingStats.total,
      mapped: mappingStats.mapped,
      unmapped: mappingStats.unmapped,
      lowConfidence: mappingStats.lowConfidence,
    },
    excludedSystemAccounts: [],
    dimensions,
    issues: derivedFromPriorYearUB
      ? [
          ...parsed.issues,
          {
            severity: 'info',
            line: 0,
            message:
              'Ingående balanser härleds från föregående års utgående balans (#UB -1) — filen saknar #IB-poster för aktuellt räkenskapsår.',
          },
        ]
      : parsed.issues,
  }
}

/**
 * Check if a file has already been imported
 */
export async function checkDuplicateImport(
  supabase: SupabaseClient,
  companyId: string,
  fileContent: string
): Promise<SIEImport | null> {
  const fileHash = await calculateFileHash(fileContent)

  const { data } = await supabase
    .from('sie_imports')
    .select('*')
    .eq('company_id', companyId)
    .eq('file_hash', fileHash)
    .eq('status', 'completed')
    .single()

  return data as SIEImport | null
}

/**
 * Check if a completed SIE import already exists for the same fiscal year period.
 * Prevents importing two different SIE files that cover the same accounting period,
 * which would create duplicate verifikationer violating BFL 4:1 (löpande bokföring).
 * Only blocks on status='completed' — failed/pending imports don't prevent retries.
 */
export async function checkDuplicatePeriodImport(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYearStart: string,
  fiscalYearEnd: string
): Promise<SIEImport | null> {
  // Range overlap check: start <= other_end AND end >= other_start.
  // Two imports whose räkenskapsår overlap would produce duplicate
  // verifikationer, violating BFL 4:1 (löpande bokföring).
  const { data } = await supabase
    .from('sie_imports')
    .select('*')
    .eq('company_id', companyId)
    .eq('status', 'completed')
    .lte('fiscal_year_start', fiscalYearEnd)
    .gte('fiscal_year_end', fiscalYearStart)
    .limit(1)
    .maybeSingle()

  return data as SIEImport | null
}

/**
 * Direct replacement without a corrected file is intentionally disabled.
 * Replacement must be initiated by uploading the new file and passing the
 * exact prior import id to executeSIEImport. finalize_sie_import then reverses
 * the old entries and posts the new import in one transaction.
 *
 * @deprecated Use executeSIEImport(..., { onExistingPeriod: 'replace',
 * replaceImportId }) with the corrected original file.
 */
export async function replaceSIEImport(
  _supabase: SupabaseClient,
  _companyId: string,
  _importId: string,
): Promise<{ success: false; reversedEntries: 0; error: string }> {
  return {
    success: false,
    reversedEntries: 0,
    error: 'Ladda upp den korrigerade SIE-filen. Den gamla importen reverseras atomiskt först när den nya filen är validerad och redo att bokföras.',
  }
}

/**
 * Undo a completed SIE import by posting exact reversal entries for every
 * transaction voucher and opening-balance entry. Originals and attachments
 * remain immutable and traceable. Marks sie_imports.status='undone'.
 *
 * Pre-flight checks mirror replaceSIEImport so the user gets a Swedish
 * error message before the RPC raises. The RPC itself is idempotent on
 * status — calling twice surfaces the "not in completed status" error.
 */
export async function undoSIEImport(
  supabase: SupabaseClient,
  companyId: string,
  importId: string,
  actorUserId: string,
): Promise<{ success: boolean; reversedEntries: number; error?: string }> {
  const { data: importRecord } = await supabase
    .from('sie_imports')
    .select('status, fiscal_period_id')
    .eq('id', importId)
    .eq('company_id', companyId)
    .single()

  if (!importRecord) {
    return { success: false, reversedEntries: 0, error: 'Import hittades inte' }
  }

  // 'partial' = posted but not archived (I18) — undoable so the user can
  // retry the whole import cleanly.
  if (importRecord.status !== 'completed' && importRecord.status !== 'partial') {
    return { success: false, reversedEntries: 0, error: `Kan bara ångra slutförda importer (status: ${importRecord.status})` }
  }

  if (importRecord.fiscal_period_id) {
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('is_closed, locked_at')
      .eq('id', importRecord.fiscal_period_id)
      .eq('company_id', companyId)
      .single()

    if (period?.is_closed || period?.locked_at) {
      return { success: false, reversedEntries: 0, error: 'Kan inte ångra import i ett låst eller stängt räkenskapsår. Öppna perioden först.' }
    }
  }

  const { data: reversedCount, error: rpcError } = await supabase.rpc('undo_sie_import_internal', {
    p_company_id: companyId,
    p_import_id: importId,
    p_actor_user_id: actorUserId,
  })

  if (rpcError) {
    return { success: false, reversedEntries: 0, error: `Kunde inte ångra import: ${rpcError.message}` }
  }

  return { success: true, reversedEntries: reversedCount as number }
}

/**
 * Clean up orphan in-flight import records for a given file hash.
 *
 * Targets rows in status='pending' — left behind when a prior import
 * crashed (or short-circuited at checkDuplicatePeriodImport) before
 * reaching finalizeImportRecord. They hold the slot in the partial
 * unique index `sie_imports_company_id_file_hash_active_idx`, so a
 * retry would fail with a constraint violation.
 *
 * Five-minute age gate protects an in-flight import in another tab/
 * session: createPendingImportRecord → ... → finalizeImportRecord can
 * take tens of seconds for large SIE files. Without the gate, a
 * concurrent retry of the same file would delete the live pending row
 * mid-flight and the original session's finalize would silently no-op.
 * Five minutes is long enough for any normal interactive import yet
 * short enough that legitimate retries after a crash succeed.
 *
 * The 'mapped' status is defined in the type but never written by any
 * code path, so we don't include it. 'failed' and 'replaced' rows are
 * allowed by the partial index (excluded from its predicate), so they
 * stay in place for the audit trail.
 */
async function cleanupStaleImportRecords(
  supabase: SupabaseClient,
  companyId: string,
  fileHash: string
): Promise<void> {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()

  // 'pending'/'validating'/'staged' rows are pre-posting states — deleting a
  // stale one loses no journal data (staging rows cascade). 'importing' is
  // NOT cleaned up: finalize_sie_import is atomic, so an 'importing' row
  // either commits to a final state or the API marks it failed.
  await supabase
    .from('sie_imports')
    .delete()
    .eq('company_id', companyId)
    .eq('file_hash', fileHash)
    .in('status', ['pending', 'validating', 'staged'])
    .lt('created_at', fiveMinutesAgo)
}

/**
 * Create a fiscal period if one doesn't exist for the date range.
 * Dates are ISO strings "YYYY-MM-DD" to avoid timezone issues.
 *
 * Exported for unit testing of the pre-validation that mirrors the
 * `enforce_period_start_day` DB trigger.
 */
export async function ensureFiscalPeriod(
  supabase: SupabaseClient,
  companyId: string,
  startDate: string,
  endDate: string
): Promise<string> {
  // Check for an existing period that contains the SIE date range
  const { data: containing } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('company_id', companyId)
    .lte('period_start', startDate)
    .gte('period_end', endDate)
    .single()

  if (containing) {
    return containing.id
  }

  // An overlapping-but-not-containing period needs to be split into two cases:
  //   - The period has any real content (posted entries, opening balances set,
  //     closed, or locked): refuse. Silently reusing it would stamp imported
  //     vouchers with a fiscal_period_id whose date window doesn't match the
  //     voucher's own date — breaking the SIE invariant that #VER dates fall
  //     inside #RAR and BFL 5 kap. (verifikationsnummer per räkenskapsår).
  //   - The period is empty (onboarding-seeded with the default calendar year
  //     but never used): replace it. The user has a förlängt räkenskapsår per
  //     BFL 3 kap. that doesn't match the seeded period, and the seeded period
  //     carries no data to preserve.
  const { data: overlapping } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end, name, is_closed, locked_at, opening_balances_set')
    .eq('company_id', companyId)
    .lte('period_start', endDate)
    .gte('period_end', startDate)
    .order('period_start', { ascending: false })
    .limit(1)

  let periodToReplaceId: string | null = null

  if (overlapping && overlapping.length > 0) {
    const existing = overlapping[0]

    const replaceableGateOpen =
      !existing.is_closed && !existing.locked_at && !existing.opening_balances_set

    let hasEntries = true
    if (replaceableGateOpen) {
      const { data: existingEntries } = await supabase
        .from('journal_entries')
        .select('id')
        .eq('fiscal_period_id', existing.id)
        .eq('company_id', companyId)
        .limit(1)
      hasEntries = (existingEntries?.length ?? 0) > 0
    }

    if (!replaceableGateOpen || hasEntries) {
      throw new Error(
        `SIE-filens räkenskapsår (${startDate} – ${endDate}) överlappar men matchar inte ett befintligt räkenskapsår i Nordklart ` +
          `(${existing.name}: ${existing.period_start} – ${existing.period_end}). ` +
          `Justera räkenskapsåret i Inställningar → Företag så att det matchar SIE-filen exakt, eller importera en SIE-fil som täcker exakt samma period.`
      )
    }

    periodToReplaceId = existing.id
  }

  // Pre-validate against the DB-side enforce_period_start_day trigger so the
  // user gets an actionable Swedish error instead of a raw Postgres message.
  // Per BFL 3 kap., only the company's chronologically FIRST fiscal year may
  // start mid-month (förlängt första räkenskapsår). Any period that comes
  // after an earlier one must start on day 1. We check "is there a period
  // that starts earlier?" rather than "does any period exist?" so a user can
  // retroactively import an old first fiscal year via SIE even after an
  // onboarding-created period already exists later in time.
  const startParts = parseDateParts(startDate)
  const endParts = parseDateParts(endDate)

  if (startParts.day !== 1) {
    const { data: earlier } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('company_id', companyId)
      .lt('period_start', startDate)
      .limit(1)

    if (earlier && earlier.length > 0) {
      throw new Error(
        `SIE-filens räkenskapsår börjar ${startDate} — endast företagets kronologiskt första räkenskapsår får börja mitt i månaden. Efterföljande räkenskapsår måste börja den 1:a i en månad (BFL 3 kap.). Kontrollera datumen i #RAR-raden.`
      )
    }
  }

  // Matches the fiscal_period_end_last_of_month CHECK constraint on prod;
  // surface it as a clean message instead of a DB error.
  const lastDayOfEndMonth = new Date(endParts.year, endParts.month, 0).getDate()
  if (endParts.day !== lastDayOfEndMonth) {
    throw new Error(
      `SIE-filens räkenskapsår slutar ${endDate} — räkenskapsår måste sluta på månadens sista dag (BFL 3 kap.). Kontrollera datumen i #RAR-raden.`
    )
  }

  // All date validation passed. If we identified an empty seeded period above,
  // delete it now — deferring the destructive step until after every check
  // keeps the seeded period intact when an SIE has malformed dates.
  // FK cascades: account_balances, voucher_sequences, voucher_gap_explanations
  // are ON DELETE CASCADE (all empty for a seeded period); sie_imports is
  // ON DELETE SET NULL; journal_entries is ON DELETE RESTRICT but we already
  // verified zero rows above.
  if (periodToReplaceId) {
    const { error: deleteError } = await supabase
      .from('fiscal_periods')
      .delete()
      .eq('id', periodToReplaceId)
      .eq('company_id', companyId)

    if (deleteError) {
      throw new Error(`Kunde inte ersätta automatiskt skapat räkenskapsår: ${deleteError.message}`)
    }
  }

  // Create new fiscal period
  const startYear = startParts.year
  const endYear = endParts.year
  const name = startYear === endYear
    ? `Räkenskapsår ${startYear}`
    : `Räkenskapsår ${startYear}/${endYear}`

  const { data: newPeriod, error } = await supabase
    .from('fiscal_periods')
    .insert({
      company_id: companyId,
      name,
      period_start: startDate,
      period_end: endDate,
      is_closed: false,
      opening_balances_set: false,
    })
    .select()
    .single()

  if (error || !newPeriod) {
    throw new Error(`Failed to create fiscal period: ${error?.message}`)
  }

  return newPeriod.id
}

/**
 * Compute IB imbalance and validate it before creating the opening balance entry.
 *
 * Distinguishes between:
 * - File-level imbalance: the raw SIE #IB data doesn't balance (source file error)
 * - Mapping-level imbalance: caused by excluded accounts (system accounts like Fortnox 0099)
 *   that carry IB balances but are correctly filtered from mapping. This is expected and
 *   should be booked to 2099 with clear documentation.
 */
export function validateIBBalance(
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>
): {
  lines: CreateJournalEntryLineInput[]
  roundingAdjustment: number
  fileImbalance: number
  excludedAccountsTotal: number
} {
  // Effective set: explicit #IB 0, or IB derived from #UB -1 (issue #675).
  const currentYearBalances = getEffectiveOpeningBalances(parsed).balances

  // First: check the raw file-level IB balance (all accounts, before mapping)
  const rawTotal = currentYearBalances.reduce((sum, b) => sum + b.amount, 0)
  const fileImbalance = Math.round(Math.abs(rawTotal) * 100) / 100

  // Build mapped lines and track excluded account totals
  const lines: CreateJournalEntryLineInput[] = []
  let excludedTotal = 0

  for (const balance of currentYearBalances) {
    const targetAccount = accountMap.get(balance.account)
    if (!targetAccount) {
      // Account not in mapping (system account or unmapped) — track its IB contribution
      excludedTotal += balance.amount
      continue
    }

    if (balance.amount > 0) {
      lines.push({
        account_number: targetAccount,
        debit_amount: balance.amount,
        credit_amount: 0,
        line_description: `IB ${balance.account}`,
      })
    } else if (balance.amount < 0) {
      lines.push({
        account_number: targetAccount,
        debit_amount: 0,
        credit_amount: Math.abs(balance.amount),
        line_description: `IB ${balance.account}`,
      })
    }
  }

  const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  const mappedDiff = Math.round((totalDebit - totalCredit) * 100) / 100

  return {
    lines,
    roundingAdjustment: Math.abs(mappedDiff) > 0.01 ? mappedDiff : 0,
    fileImbalance,
    excludedAccountsTotal: Math.round(excludedTotal * 100) / 100,
  }
}

/**
 * Build the opening-balance payload from IB amounts (pure — posting happens
 * inside finalize_sie_import's atomic transaction).
 * The caller must validate the IB balance first via validateIBBalance().
 * If roundingAdjustment is non-zero, it is booked explicitly to 2099 with clear text.
 */
export function buildOpeningBalancePayload(
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>,
  roundingAdjustment: number
): { entry_date: string; description: string; lines: CreateJournalEntryLineInput[] } | null {
  // Effective set: explicit #IB 0, or IB derived from #UB -1 (issue #675).
  const { balances: currentYearBalances, derivedFromPriorYearUB } =
    getEffectiveOpeningBalances(parsed)

  if (currentYearBalances.length === 0) {
    return null
  }

  const lines: CreateJournalEntryLineInput[] = []

  for (const balance of currentYearBalances) {
    const targetAccount = accountMap.get(balance.account)
    if (!targetAccount) continue

    if (balance.amount > 0) {
      lines.push({
        account_number: targetAccount,
        debit_amount: balance.amount,
        credit_amount: 0,
        line_description: `IB ${balance.account}`,
      })
    } else if (balance.amount < 0) {
      lines.push({
        account_number: targetAccount,
        debit_amount: 0,
        credit_amount: Math.abs(balance.amount),
        line_description: `IB ${balance.account}`,
      })
    }
  }

  if (lines.length === 0) {
    return null
  }

  // Add explicit rounding adjustment if needed (pre-validated by caller)
  if (Math.abs(roundingAdjustment) > 0.01) {
    if (roundingAdjustment > 0) {
      lines.push({
        account_number: '2099',
        debit_amount: 0,
        credit_amount: roundingAdjustment,
        line_description: `Avrundningsdifferens vid SIE-import, ${roundingAdjustment} SEK`,
      })
    } else {
      lines.push({
        account_number: '2099',
        debit_amount: Math.abs(roundingAdjustment),
        credit_amount: 0,
        line_description: `Avrundningsdifferens vid SIE-import, ${roundingAdjustment} SEK`,
      })
    }
  }

  const entryDate = parsed.stats.fiscalYearStart ?? formatDate(new Date())

  return {
    entry_date: entryDate,
    // When derived, say so on the voucher itself — permanent documentation
    // of where the amounts came from (BFNAR 2013:2 behandlingshistorik).
    description: derivedFromPriorYearUB
      ? 'Ingående balanser från SIE-import (härledda från föregående års utgående balans)'
      : 'Ingående balanser från SIE-import',
    lines,
  }
}

/**
 * Returns true when the company already has at least one posted (or reversed)
 * non-IB journal entry — i.e. this is a continuation import, not the first
 * ever SIE upload for the company.
 *
 * Used to gate IB-entry creation: when a company is already live, each year's
 * #IB equals the prior year's UB, which is the sum of already-imported
 * journal lines. Creating a new IB entry would double-count one year's
 * movements against every balance-sheet account.
 */
export async function companyHasPriorActivity(
  supabase: SupabaseClient,
  companyId: string
): Promise<boolean> {
  // Only count currently-effective real activity. Excluding 'reversed' drops
  // cancelled originals; excluding source_type 'storno' drops their matching
  // reversal entries so a fully-cancelled pair contributes nothing. Without
  // this, repair scripts that storno duplicate IB entries would leave storno
  // artifacts that trip the guard on a freshly-repaired company.
  const { count } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .neq('source_type', 'opening_balance')
    .neq('source_type', 'storno')
    .eq('status', 'posted')

  return (count ?? 0) > 0
}

/**
 * Link an opening-balance journal entry to its fiscal period so balance-sheet
 * reports use the explicit IB path in getOpeningBalances() (reads only that
 * entry's lines for IB) instead of falling through to summing all prior
 * journal lines — which inflates multi-year imports, because each year's IB
 * is double-counted against the prior year's UB.
 *
 * Mirrors the pattern used by the Excel-based OB import at
 * app/api/import/opening-balance/execute/route.ts:224-231.
 */
export async function linkOpeningBalanceEntryToPeriod(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  openingBalanceEntryId: string
): Promise<void> {
  const { error } = await supabase
    .from('fiscal_periods')
    .update({
      opening_balance_entry_id: openingBalanceEntryId,
      opening_balances_set: true,
    })
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)

  if (error) {
    throw new Error(`Failed to link opening balance entry to fiscal period: ${error.message}`)
  }
}



/**
 * Compute per-series voucher number ranges from the voucher number mapping.
 * SIE imports can span multiple series (B, C, V, ...), each with its own
 * independent target-number range, so the documentation records one range
 * per series.
 */
export function computeVoucherNumberRanges(
  mapping: Array<{ sourceId: string; series: string; targetNumber: number }>
): Array<{ series: string; from: number; to: number }> {
  if (mapping.length === 0) return []
  const bySeries = new Map<string, { from: number; to: number }>()
  for (const entry of mapping) {
    const existing = bySeries.get(entry.series)
    if (existing) {
      if (entry.targetNumber < existing.from) existing.from = entry.targetNumber
      if (entry.targetNumber > existing.to) existing.to = entry.targetNumber
    } else {
      bySeries.set(entry.series, { from: entry.targetNumber, to: entry.targetNumber })
    }
  }
  return [...bySeries.entries()].map(([series, range]) => ({ series, ...range }))
}

/**
 * Create a migration adjustment entry (omföringsverifikation) to reconcile
 * imported voucher movements against the SIE file's closing balances.
 *
 * When unbalanced vouchers are skipped during import, the sum of imported
 * movements will differ from the true account balances computed by the source
 * system. This function:
 *   1. Computes expected net movements from #UB (balance sheet) and #RES (result),
 *      separated by account class per Fix 8
 *   2. Compares against actual imported movements
 *   3. Books the per-account delta as a proper omföringsverifikation
 *
 * Per BFL 1999:1078 and BFNAR 2013:2, corrections must be documented through
 * verifikationer with clear descriptions. This satisfies that requirement.
 */
async function createMigrationAdjustmentEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  sieImportId: string,
  approveOreRounding: boolean,
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>,
  importedMovements: Map<string, number>,
  skippedDetails: {
    voucherId: string
    date: string
    reason: string
  }[]
): Promise<{ entryId: string | null; deltaAccounts: number; warnings: string[] }> {
  const warnings: string[] = []
  const hasUB = parsed.closingBalances.some((b) => b.yearIndex === 0)
  const hasRES = parsed.resultBalances.some((b) => b.yearIndex === 0)

  if (!hasUB && !hasRES) {
    return { entryId: null, deltaAccounts: 0, warnings }
  }

  // Fix 8: Separate BS/P&L reconciliation
  // For BS accounts (class 1-2): expectedMovement = UB - IB (ignore RES)
  // For P&L accounts (class 3-8): expectedMovement = RES (ignore IB/UB)
  const expectedMovements = new Map<string, number>()

  // Process IB — only for balance sheet accounts. Effective set: explicit
  // #IB 0, or IB derived from #UB -1 (issue #675) — so the expected BS
  // movement is UB(0) − UB(-1), the correct one-year movement, instead of
  // treating the whole opening balance as unexplained movement.
  for (const ib of getEffectiveOpeningBalances(parsed).balances) {
    const target = accountMap.get(ib.account)
    if (!target) continue
    if (!isBalanceSheetAccount(target)) {
      // P&L account appearing in IB — likely malformed SIE
      warnings.push(`P&L-konto ${ib.account} (→${target}) förekommer i #IB — ignoreras för resultaträkning`)
      continue
    }
    expectedMovements.set(target, (expectedMovements.get(target) || 0) - ib.amount)
  }

  // Process UB — only for balance sheet accounts
  for (const ub of parsed.closingBalances.filter((b) => b.yearIndex === 0)) {
    const target = accountMap.get(ub.account)
    if (!target) continue
    if (!isBalanceSheetAccount(target)) {
      warnings.push(`P&L-konto ${ub.account} (→${target}) förekommer i #UB — ignoreras för resultaträkning`)
      continue
    }
    expectedMovements.set(target, (expectedMovements.get(target) || 0) + ub.amount)
  }

  // Process RES — only for P&L accounts
  for (const res of parsed.resultBalances.filter((b) => b.yearIndex === 0)) {
    const target = accountMap.get(res.account)
    if (!target) continue
    if (isBalanceSheetAccount(target)) {
      warnings.push(`Balanskonto ${res.account} (→${target}) förekommer i #RES — ignoreras för balansräkning`)
      continue
    }
    expectedMovements.set(target, (expectedMovements.get(target) || 0) + res.amount)
  }

  // Compute per-account delta: expected - imported
  const lines: CreateJournalEntryLineInput[] = []
  const allAccounts = new Set([...expectedMovements.keys(), ...importedMovements.keys()])
  let deltaAccountCount = 0

  for (const account of allAccounts) {
    const expected = expectedMovements.get(account) || 0
    const imported = importedMovements.get(account) || 0
    const delta = Math.round((expected - imported) * 100) / 100

    if (Math.abs(delta) < 0.01) continue
    deltaAccountCount++

    // Fix 4: Per-line text referencing what the adjustment concerns
    const lineDesc = `Justering konto ${account}: delta ${delta} SEK från ${skippedDetails.length} exkl. verifikationer`

    if (delta > 0) {
      lines.push({
        account_number: account,
        debit_amount: delta,
        credit_amount: 0,
        line_description: lineDesc,
      })
    } else {
      lines.push({
        account_number: account,
        debit_amount: 0,
        credit_amount: Math.abs(delta),
        line_description: lineDesc,
      })
    }
  }

  if (lines.length === 0) {
    return { entryId: null, deltaAccounts: 0, warnings }
  }

  // The entry must balance. It should by construction, but verify and handle rounding.
  const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  const balanceDiff = Math.round(Math.abs(totalDebit - totalCredit) * 100) / 100

  if (balanceDiff > 0.005) {
    const roundedDiff = Math.round((totalDebit - totalCredit) * 100) / 100
    if (!approveOreRounding) {
      throw new Error(
        `Migreringsjusteringen har en differens på ${Math.abs(roundedDiff).toFixed(2)} kr. ` +
          'Konto 3741 får endast läggas till efter uttryckligt godkännande av öresutjämningen.',
      )
    }
    if (roundedDiff > 0) {
      lines.push({
        account_number: '3741',
        debit_amount: 0,
        credit_amount: Math.abs(roundedDiff),
        line_description: 'Öresutjämning omföringsverifikation',
      })
    } else {
      lines.push({
        account_number: '3741',
        debit_amount: Math.abs(roundedDiff),
        credit_amount: 0,
        line_description: 'Öresutjämning omföringsverifikation',
      })
    }
  }

  // Date the adjustment at fiscal year end
  const entryDate = parsed.stats.fiscalYearEnd ?? formatDate(new Date())

  // Fix 4: Build structured description with skipped voucher details
  const skippedIds = skippedDetails.map(d => d.voucherId)
  const skippedDates = skippedDetails.map(d => d.date).sort()
  const firstId = skippedIds[0] || '?'
  const lastId = skippedIds[skippedIds.length - 1] || '?'
  const firstDate = skippedDates[0] || '?'
  const lastDate = skippedDates[skippedDates.length - 1] || '?'

  const draft = await createDraftEntry(supabase, companyId, userId, {
    fiscal_period_id: fiscalPeriodId,
    entry_date: entryDate,
    description: `Omföringsverifikation: justering för ${skippedDetails.length} exkluderade verifikationer (${firstId}–${lastId}, ${firstDate}–${lastDate}) vid SIE-import`,
    source_type: 'import',
    source_id: sieImportId,
    voucher_series: 'M',
    lines,
  })

  // The adjustment is created by the import and must therefore carry the
  // exact same provenance before it is posted. Undo/replace intentionally
  // fail closed instead of guessing by period or source_type.
  const { error: provenanceError } = await supabase
    .from('journal_entries')
    .update({
      sie_import_id: sieImportId,
      external_reference: 'migration_adjustment',
    })
    .eq('id', draft.id)
    .eq('company_id', companyId)
    .eq('status', 'draft')

  if (provenanceError) {
    await supabase
      .from('journal_entries')
      .update({ status: 'cancelled' })
      .eq('id', draft.id)
      .eq('company_id', companyId)
      .eq('status', 'draft')
    throw new Error(`Migreringsjusteringens importproveniens kunde inte sparas: ${provenanceError.message}`)
  }

  try {
    const entry = await commitEntry(
      supabase,
      companyId,
      userId,
      draft.id,
      'sie_migration_adjustment',
    )
    return { entryId: entry.id, deltaAccounts: deltaAccountCount, warnings }
  } catch (error) {
    await supabase
      .from('journal_entries')
      .update({ status: 'cancelled' })
      .eq('id', draft.id)
      .eq('company_id', companyId)
      .eq('status', 'draft')
    throw error
  }
}

/**
 * Ensure a specific account exists in the user's chart of accounts.
 * Uses BAS reference for metadata when available, falls back to derivation.
 */
async function ensureAccountExists(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountNumber: string,
  accountName: string
): Promise<void> {
  const { data } = await supabase
    .from('chart_of_accounts')
    .select('id')
    .eq('company_id', companyId)
    .eq('account_number', accountNumber)
    .single()

  if (data) return // Already exists

  const basRef = getBASReference(accountNumber)

  if (basRef) {
    await supabase.from('chart_of_accounts').insert({
      user_id: userId,
      company_id: companyId,
      account_number: accountNumber,
      account_name: basRef.account_name,
      account_class: basRef.account_class,
      account_group: basRef.account_group,
      account_type: basRef.account_type,
      normal_balance: basRef.normal_balance,
      sru_code: basRef.sru_code ?? computeSRUCode(accountNumber),
      k2_excluded: basRef.k2_excluded,
      plan_type: 'full_bas',
      is_active: true,
      is_system_account: false,
    })
    return
  }

  // Fallback: derive metadata from account number
  const classNum = parseInt(accountNumber.charAt(0), 10)
  const group = accountNumber.substring(0, 2)
  const classified = classifyAccount(accountNumber)

  await supabase.from('chart_of_accounts').insert({
    user_id: userId,
    company_id: companyId,
    account_number: accountNumber,
    account_name: accountName,
    account_class: classNum,
    account_group: group,
    account_type: classified.account_type,
    normal_balance: classified.normal_balance,
    sru_code: computeSRUCode(accountNumber),
    plan_type: 'full_bas',
    is_active: true,
    is_system_account: false,
  })
}

/**
 * Phase 1: Create a pending import record early, before any journal entries.
 * This ensures the import is tracked even if later steps fail.
 */
async function createPendingImportRecord(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  parsed: ParsedSIEFile,
  fileContent: string,
  filename: string,
  replacesImportId?: string | null,
  parseSessionId?: string | null,
): Promise<string> {
  const fileHash = await calculateFileHash(fileContent)

  // Clean up any stale pending/failed records for this hash to avoid UNIQUE conflicts
  await cleanupStaleImportRecords(supabase, companyId, fileHash)

  const { data, error } = await supabase
    .from('sie_imports')
    .insert({
      user_id: userId,
      company_id: companyId,
      filename,
      file_hash: fileHash,
      org_number: parsed.header.orgNumber,
      company_name: parsed.header.companyName,
      sie_type: parsed.header.sieType,
      fiscal_year_start: parsed.stats.fiscalYearStart ?? null,
      fiscal_year_end: parsed.stats.fiscalYearEnd ?? null,
      accounts_count: parsed.stats.totalAccounts,
      transactions_count: 0,
      status: 'pending',
      imported_at: null,
      // Replace-in-progress rows are exempt from the active-hash unique index
      // (a replace of the identical file legitimately shares the hash with
      // the row it supersedes — I06).
      replaces_import_id: replacesImportId ?? null,
      parse_session_id: parseSessionId ?? null,
    })
    .select('id')
    .single()

  if (error || !data) {
    // PG error 23505 (unique_violation) on the partial index means another
    // active row exists for the same (company_id, file_hash). Surface the
    // recovery path in Swedish instead of leaking the raw Postgres message.
    const pgCode = (error as { code?: string } | null | undefined)?.code
    const pgMessage = error?.message ?? ''
    const hitsActiveIdx =
      pgCode === '23505' &&
      pgMessage.includes('sie_imports_company_id_file_hash_active_idx')

    if (hitsActiveIdx) {
      throw new Error(
        'En tidigare SIE-import för samma fil finns redan i nordklart. Öppna importhistoriken och välj "Ersätt import" på den befintliga raden, eller använd Fortnox-synkningen för att hämta uppdaterad data automatiskt.'
      )
    }

    throw new Error(`Failed to create pending import record: ${pgMessage}`)
  }

  return data.id
}

/**
 * Phase 2: Finalize the import record — archive first, then flip the status
 * through the controlled complete_sie_import RPC (I17, I18, I24).
 *
 * Archive policy (I18): an import may only become 'completed' when the
 * original file has been archived (BFL 7 kap 1-2§ — the file IS the
 * räkenskapsinformation). If archiving fails after the vouchers were posted,
 * the import finalizes as 'partial' with archive_error set; 'partial'
 * imports block year-end readiness until resolved.
 */
export async function finalizeImportRecord(
  supabase: SupabaseClient,
  importId: string,
  companyId: string,
  result: ImportResult,
  fileContent: string,
  documentation?: MigrationDocumentation
): Promise<void> {
  // Safety net: if the import ran without errors but didn't actually create
  // any journal entries (no OB entry, no vouchers), refuse to mark it as
  // 'completed'. A 'completed' row with transactions_count=0 would claim
  // the (company_id, file_hash) slot in the partial unique index and the
  // overlapping-period check would block any retry.
  const noEntriesCreated =
    result.success &&
    result.journalEntriesCreated === 0 &&
    !result.openingBalanceEntryId
  if (noEntriesCreated) {
    result.success = false
    if (result.errors.length === 0) {
      result.errors.push(
        'Importen skapade 0 verifikationer — markerar som misslyckad så filen ' +
        'kan importeras om utan replace/undo. Granska varningarna för att se ' +
        'vilka konton som behöver mappas.',
      )
    }
  }

  // Metadata update (not status — the RPC owns the state transition).
  const { error: metaError } = await supabase
    .from('sie_imports')
    .update({
      transactions_count: result.journalEntriesCreated,
      fiscal_period_id: result.fiscalPeriodId,
      opening_balance_entry_id: result.openingBalanceEntryId,
      migration_documentation: documentation ?? null,
    })
    .eq('id', importId)
    .eq('company_id', companyId)
  if (metaError) {
    // Controlled status finalization (I17): a metadata write failure must
    // not let the import masquerade as completed.
    result.success = false
    result.errors.push(`Importstatus kunde inte sparas: ${metaError.message}`)
  }

  // Archive BEFORE completion (I18).
  let archived = false
  let archiveError: string | null = null
  let storagePath: string | null = null
  if (result.success) {
    storagePath = `${companyId}/${importId}.se`
    const fileBlob = new Blob([fileContent], { type: 'text/plain' })
    const { error: uploadError } = await supabase.storage
      .from('sie-files')
      .upload(storagePath, fileBlob, { upsert: false })

    if (uploadError) {
      // 'Duplicate' means the file is already archived (idempotent retry).
      if (/already exists|duplicate/i.test(uploadError.message)) {
        archived = true
      } else {
        archiveError = uploadError.message
        storagePath = null
        result.warnings.push(
          `Originalfilen kunde inte arkiveras (${uploadError.message}). ` +
          `Importen markeras som "partial" tills arkiveringen lyckas — bokförda verifikationer påverkas inte.`
        )
      }
    } else {
      archived = true
    }
  }

  const finalStatus = !result.success ? 'failed' : archived ? 'completed' : 'partial'

  const { error: completeError } = await supabase.rpc('complete_sie_import', {
    p_company_id: companyId,
    p_import_id: importId,
    p_status: finalStatus,
    p_error_message: result.errors.length > 0 ? result.errors.join('; ') : null,
    // The persisted list IS the response list (I24).
    p_warnings: result.warnings,
    p_archived: archived,
    p_archive_error: archiveError,
    p_file_storage_path: storagePath,
  })

  if (completeError) {
    // The API must not answer success when the status could not be saved (I17).
    result.success = false
    result.errors.push(`Importstatus kunde inte finaliseras: ${completeError.message}`)
  } else if (finalStatus === 'partial') {
    result.success = false
    result.errors.push(
      'Importen bokfördes men originalfilen kunde inte arkiveras — status "partial". Försök arkivera igen från importhistoriken.'
    )
  }
}

/**
 * Save account mappings to the database for future use
 */
export async function saveMappings(
  supabase: SupabaseClient,
  companyId: string,
  mappings: AccountMapping[]
): Promise<void> {
  // Filter to only mapped accounts
  const mappingsToSave = mappings
    .filter((m) => m.targetAccount)
    .map((m) => ({
      company_id: companyId,
      source_account: m.sourceAccount,
      source_name: m.sourceName,
      target_account: m.targetAccount,
      confidence: m.confidence,
      match_type: m.matchType,
    }))

  if (mappingsToSave.length === 0) return

  // Batch upsert in chunks of 100
  const BATCH_SIZE = 100
  for (let i = 0; i < mappingsToSave.length; i += BATCH_SIZE) {
    const batch = mappingsToSave.slice(i, i + BATCH_SIZE)
    await supabase
      .from('sie_account_mappings')
      .upsert(batch, {
        onConflict: 'company_id,source_account',
      })
  }
}

/**
 * Load existing account mappings for a user
 */
export async function loadMappings(supabase: SupabaseClient, companyId: string): Promise<Map<string, AccountMapping>> {
  const { data } = await supabase
    .from('sie_account_mappings')
    .select('*')
    .eq('company_id', companyId)

  const map = new Map<string, AccountMapping>()

  for (const record of data || []) {
    map.set(record.source_account, {
      sourceAccount: record.source_account,
      sourceName: record.source_name || '',
      targetAccount: record.target_account,
      targetName: '', // Will be filled in by the mapper
      confidence: record.confidence,
      matchType: record.match_type,
      isOverride: true,
    })
  }

  return map
}

/**
 * Execute the full SIE import
 *
 * `onExistingPeriod` controls how a prior completed import that overlaps
 * the new SIE's fiscal year is handled:
 *   - 'block' (default): refuse with a Swedish error. Used by the manual
 *     upload route in app/api/import/sie. Preserves prior behavior.
 *   - 'replace': bind the new staged import to one explicitly selected
 *     completed import. The database validates the relationship, reverses
 *     every precisely tagged posted entry and only then posts the corrected
 *     import in the same finalization transaction.
 *
 * Replacement never guesses by period or source_type and never hard-deletes
 * posted entries. Native Nordklart entries are outside the import provenance
 * and remain untouched.
 *
 * `updateAccountNames` (default true) carries the SIE file's #KONTO names
 * into the chart for identity-mapped accounts: new accounts are created with
 * the file's name and existing accounts whose name differs are renamed.
 * When false, accounts are created with BAS default names and existing
 * accounts are left untouched (the pre-2026-06 behavior).
 */
/**
 * Upsert SIE dimension objects into the dimension registers:
 * dimension 1 (kostnadsställe) → cost_centers, dimension 6 (projekt) →
 * projects. Codes referenced on voucher lines but missing a #OBJEKT
 * definition are registered with the code as name. Idempotent on
 * (company_id, code).
 */
export async function syncDimensionRegisters(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  parsed: ParsedSIEFile,
): Promise<void> {
  const costCenterNames = new Map<string, string>()
  const projectNames = new Map<string, string>()

  for (const obj of parsed.objects ?? []) {
    if (obj.dimension === '1') costCenterNames.set(obj.code, obj.name || obj.code)
    if (obj.dimension === '6') projectNames.set(obj.code, obj.name || obj.code)
  }

  for (const voucher of parsed.vouchers) {
    for (const line of voucher.lines) {
      for (const ref of line.objectList ?? []) {
        if (ref.dimension === '1' && !costCenterNames.has(ref.code)) {
          costCenterNames.set(ref.code, ref.code)
        }
        if (ref.dimension === '6' && !projectNames.has(ref.code)) {
          projectNames.set(ref.code, ref.code)
        }
      }
    }
  }

  if (costCenterNames.size > 0) {
    await supabase.from('cost_centers').upsert(
      Array.from(costCenterNames.entries()).map(([code, name]) => ({
        user_id: userId,
        company_id: companyId,
        code,
        name,
        is_active: true,
      })),
      { onConflict: 'company_id,code', ignoreDuplicates: true },
    )
  }

  if (projectNames.size > 0) {
    await supabase.from('projects').upsert(
      Array.from(projectNames.entries()).map(([code, name]) => ({
        user_id: userId,
        company_id: companyId,
        code,
        name,
        is_active: true,
      })),
      { onConflict: 'company_id,code', ignoreDuplicates: true },
    )
  }
}

/**
 * Execute a SIE import through the staged, atomic posting flow
 * (revision items I01–I18, I24).
 *
 * Flow:
 *   1. Server-side validation: mapping coverage, duplicate checks, #KSUMMA
 *      verification (I19), voucher date-range guards.
 *   2. prepareStagedVouchers() applies the STRICT difference policy (I15):
 *      diffs ≤ 1 öre get an explicit öresutjämning line, anything larger
 *      requires the caller's explicit approval or blocks the import.
 *   3. Vouchers are staged into sie_import_staging (idempotent batches, I05)
 *      and posted by the finalize_sie_import RPC in ONE transaction through
 *      the same validation path as the engine (I01–I03), including precise
 *      replace of a prior import (I06/I07) and the N→N+1 opening balance
 *      resync with exact continuity (I12).
 *   4. The original file is archived BEFORE the import may become
 *      'completed' (I18); archive failure finalizes as 'partial'.
 *   5. The persisted warning list and the API response share the same final
 *      array (I24).
 */
export async function executeSIEImport(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  parsed: ParsedSIEFile,
  mappings: AccountMapping[],
  options: {
    filename: string
    fileContent: string
    createFiscalPeriod: boolean
    importOpeningBalances: boolean
    importTransactions: boolean
    voucherSeries?: string
    onExistingPeriod?: 'block' | 'replace'
    /** Exact completed import selected for atomic replacement. Never trusted without server validation. */
    replaceImportId?: string | null
    updateAccountNames?: boolean
    /** Explicitly approve öresutjämning (3741) for every non-zero diff up to 1.00 SEK (I15). */
    approveOreRounding?: boolean
    /** Explicitly approve skipping unpostable vouchers (I15). */
    approveSkippedVouchers?: boolean
    /** Explicitly approve the migration adjustment compensation entry (I16). */
    approveMigrationAdjustment?: boolean
    /** Explicitly proceed despite a #KSUMMA mismatch (I19). */
    ignoreKsummaMismatch?: boolean
    /** Raw file bytes (pre-decoding) for #KSUMMA verification. */
    rawFileBytes?: Uint8Array
    /** Durable parse session whose archived original is the execute source. */
    parseSessionId?: string | null
  }
): Promise<ImportResult> {
  const result: ImportResult = {
    success: false,
    importId: null,
    fiscalPeriodId: null,
    openingBalanceEntryId: null,
    journalEntriesCreated: 0,
    journalEntryIds: [],
    errors: [],
    warnings: [],
    replacedPriorImport: null,
  }

  const onExistingPeriod = options.onExistingPeriod ?? 'block'
  const updateAccountNames = options.updateAccountNames ?? true
  const policy = {
    approveOreRounding: options.approveOreRounding ?? false,
    approveSkippedVouchers: options.approveSkippedVouchers ?? false,
  }

  try {
    // Validate all accounts are mapped
    const unmapped = mappings.filter((m) => !m.targetAccount)
    if (unmapped.length > 0) {
      result.errors.push(
        `${unmapped.length} accounts are not mapped: ${unmapped.map((m) => m.sourceAccount).join(', ')}`
      )
      return result
    }

    // #KSUMMA verification (I19): when the file declares a checksum it must
    // verify, or the caller must explicitly acknowledge the mismatch.
    let ksummaDeclared: string | null = null
    let ksummaVerified: boolean | null = null
    if (options.rawFileBytes) {
      const ksumma = verifySieKsumma(options.rawFileBytes)
      ksummaDeclared = ksumma.declared
      ksummaVerified = ksumma.matches
      if (ksumma.matches === false) {
        if (options.ignoreKsummaMismatch) {
          result.warnings.push(
            `#KSUMMA stämmer inte (deklarerad ${ksumma.declared}, beräknad ${ksumma.computed}) — importen fortsätter efter uttryckligt godkännande.`
          )
        } else {
          result.errors.push(
            `#KSUMMA-kontrollsumman stämmer inte: filen deklarerar ${ksumma.declared} men innehållet ger ${ksumma.computed}. ` +
              `Filen kan vara ändrad eller trunkerad. Exportera om filen från källsystemet, eller godkänn avvikelsen uttryckligen (ignore_ksumma_mismatch).`
          )
          return result
        }
      }
    }

    // Defense in depth: refuse to enter executeSIEImport when the mapping
    // doesn't cover a single account present in the file. Without this guard
    // a stale MCP client (or the HTTP execute route) could still drive the
    // import to silently skip every voucher and write a 0-entry 'completed'
    // sie_imports row that holds the unique-index slot.
    const sourceAccountsInFile = new Set<string>()
    for (const v of parsed.vouchers) for (const l of v.lines) sourceAccountsInFile.add(l.account)
    if (options.importOpeningBalances) {
      for (const b of getEffectiveOpeningBalances(parsed).balances) {
        sourceAccountsInFile.add(b.account)
      }
    }
    const mappedSources = new Set(
      mappings.filter((m) => m.targetAccount).map((m) => m.sourceAccount),
    )
    const hasOverlap = [...sourceAccountsInFile].some((a) => mappedSources.has(a))
    if (sourceAccountsInFile.size > 0 && !hasOverlap) {
      const sample = [...sourceAccountsInFile].slice(0, 8).join(', ')
      result.errors.push(
        `Kontomappningarna täcker inga konton i SIE-filen. ` +
        `Filen innehåller ${sourceAccountsInFile.size} unika källkonton ` +
        `(t.ex. ${sample}), men inget av dem finns i mappings.sourceAccount. ` +
        `Importen avbryts innan en sie_imports-rad skapas så att du kan ` +
        `försöka igen med korrekta mappningar.`,
      )
      return result
    }

    // Replace mode (I06): identify the prior import but do NOT delete it here.
    // The deletion happens INSIDE finalize_sie_import's transaction, after
    // the new vouchers have been fully validated — a failure rolls everything
    // back and the old import stays untouched.
    let replacesImportId: string | null = options.replaceImportId ?? null
    if (onExistingPeriod === 'replace' && !replacesImportId) {
      const fyStart = parsed.stats.fiscalYearStart
      const fyEnd = parsed.stats.fiscalYearEnd
      if (fyStart && fyEnd) {
        const priorPeriodImport = await checkDuplicatePeriodImport(
          supabase, companyId, fyStart, fyEnd
        )
        if (priorPeriodImport) replacesImportId = priorPeriodImport.id
      }
    }

    // Block mode (default): the hash and period checks reject duplicates with
    // graceful Swedish errors. Skipped in replace mode because finalize
    // atomically supersedes any prior import.
    if (onExistingPeriod === 'block') {
      const duplicate = await checkDuplicateImport(supabase, companyId, options.fileContent)
      if (duplicate) {
        result.errors.push(
          `This file has already been imported on ${duplicate.imported_at ? new Date(duplicate.imported_at).toLocaleDateString('sv-SE') : 'okänt datum'}`
        )
        return result
      }
    }

    // Create pending import record early — ensures tracking even if later steps fail
    result.importId = await createPendingImportRecord(
      supabase,
      companyId,
      userId,
      parsed,
      options.fileContent,
      options.filename,
      replacesImportId,
      options.parseSessionId,
    )

    // Persist the KSUMMA verification outcome on the import row.
    if (ksummaDeclared !== null) {
      await supabase
        .from('sie_imports')
        .update({ ksumma_declared: ksummaDeclared, ksumma_verified: ksummaVerified })
        .eq('id', result.importId)
        .eq('company_id', companyId)
    }

    // Build account mapping lookup
    const accountMap = mappingsToMap(mappings)

    // Ensure all mapped target accounts exist in chart_of_accounts and,
    // unless disabled, carry the SIE file's #KONTO names into the chart.
    const accountSync = await syncMappedAccounts(
      supabase,
      companyId,
      userId,
      mappings,
      updateAccountNames
    )
    if (accountSync.error) {
      result.errors.push(`Failed to create accounts: ${accountSync.error}`)
      await finalizeImportRecord(supabase, result.importId, companyId, result, options.fileContent)
      return result
    }
    if (accountSync.renamed > 0) {
      result.warnings.push(
        accountSync.renamed === 1
          ? '1 konto bytte namn till namnet från SIE-filen'
          : `${accountSync.renamed} konton bytte namn till namnen från SIE-filen`
      )
    }
    if (accountSync.renameFailed > 0) {
      result.warnings.push(
        `${accountSync.renameFailed} kontonamn kunde inte uppdateras från SIE-filen`
      )
    }

    // Create or find fiscal period
    const fiscalYearStart = parsed.stats.fiscalYearStart
    const fiscalYearEnd = parsed.stats.fiscalYearEnd

    if (!fiscalYearStart || !fiscalYearEnd) {
      result.errors.push('No fiscal year defined in the SIE file')
      await finalizeImportRecord(supabase, result.importId, companyId, result, options.fileContent)
      return result
    }

    // Safety net: reject if a completed import already exists for this period.
    if (onExistingPeriod === 'block') {
      const periodDuplicate = await checkDuplicatePeriodImport(
        supabase, companyId, fiscalYearStart, fiscalYearEnd
      )
      if (periodDuplicate) {
        result.errors.push(
          `En SIE-import för ett överlappande räkenskapsår (${periodDuplicate.fiscal_year_start} – ${periodDuplicate.fiscal_year_end}) finns redan`
        )
        await finalizeImportRecord(supabase, result.importId, companyId, result, options.fileContent)
        return result
      }
    }

    if (options.createFiscalPeriod) {
      result.fiscalPeriodId = await ensureFiscalPeriod(
        supabase,
        companyId,
        fiscalYearStart,
        fiscalYearEnd
      )
    } else {
      const { data: existing } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('company_id', companyId)
        .lte('period_start', fiscalYearStart)
        .gte('period_end', fiscalYearEnd)
        .single()

      if (!existing) {
        result.errors.push('No matching fiscal period found. Enable "Create fiscal period" option.')
        await finalizeImportRecord(supabase, result.importId, companyId, result, options.fileContent)
        return result
      }

      result.fiscalPeriodId = existing.id
    }

    // Stamp the resolved period on the import row so finalize_sie_import can
    // read it (and so a failed import is still traceable to its period).
    await supabase
      .from('sie_imports')
      .update({ fiscal_period_id: result.fiscalPeriodId })
      .eq('id', result.importId)
      .eq('company_id', companyId)

    // Track documentation data across import phases
    let ibRoundingAdjustment = 0
    let ibExplanation: 'unallocated_result' | 'excluded_accounts' | 'rounding' | null = null
    let migrationAdjustmentInfo = { created: false, deltaAccounts: 0, entryId: null as string | null }
    const voucherNumberMapping: Array<{ sourceId: string; series: string; targetNumber: number }> = []
    let voucherSeriesUsed: string[] = []
    let voucherStats = {
      total: parsed.vouchers.length,
      imported: 0,
      skippedUnbalanced: 0,
      skippedUnmapped: 0,
      skippedSingleLine: 0,
      skippedEmpty: 0,
    }
    const defaultSeries = options.voucherSeries || 'B'

    // ── Opening balances (period N) ─────────────────────────────────────────
    //
    // IB imbalance is NORMAL in Swedish SIE files (excluded system accounts,
    // unallocated prior-year result). The diff is booked to 2099 with
    // explicit documentation — never silently.
    let openingBalancePayload: { entry_date: string; description: string; lines: CreateJournalEntryLineInput[] } | null = null
    const effectiveIB = getEffectiveOpeningBalances(parsed)
    if (options.importOpeningBalances && effectiveIB.balances.length > 0 && result.fiscalPeriodId) {
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('opening_balances_set, opening_balance_entry_id')
        .eq('id', result.fiscalPeriodId)
        .single()

      if (period?.opening_balances_set || period?.opening_balance_entry_id) {
        result.warnings.push('Ingående balanser finns redan för denna period — hoppar över IB-import')
      } else {
        const isContinuationImport = await companyHasPriorActivity(supabase, companyId)

        if (isContinuationImport) {
          result.warnings.push(
            'Ingående balanser hoppades över eftersom bolaget redan har bokförda verifikationer. ' +
            'Ingående balans för denna period härleds från föregående periods utgående balans. ' +
            'Stäm av mot SIE-filens #IB om du är osäker.'
          )
        } else {
          const ibValidation = validateIBBalance(parsed, accountMap)

          if (ibValidation.lines.length > 0) {
            if (effectiveIB.derivedFromPriorYearUB) {
              result.warnings.push(
                'SIE-filen saknar ingående balanser (#IB) för räkenskapsåret. ' +
                'Ingående balanser härleddes från föregående års utgående balanser (#UB -1) enligt kontinuitetsprincipen.'
              )
            }

            const absAdj = Math.abs(ibValidation.roundingAdjustment)

            if (absAdj > 0.01) {
              ibRoundingAdjustment = ibValidation.roundingAdjustment

              if (Math.abs(ibValidation.excludedAccountsTotal) > 0.01 && ibValidation.fileImbalance <= 1.00) {
                ibExplanation = 'excluded_accounts'
                result.warnings.push(
                  `Exkluderade systemkonton har IB-saldon på totalt ${ibValidation.excludedAccountsTotal} SEK. ` +
                  `Differensen (${ibValidation.roundingAdjustment} SEK) bokförs på konto 2099.`
                )
              } else if (ibValidation.fileImbalance > 1.00) {
                ibExplanation = 'unallocated_result'
                result.warnings.push(
                  `Ingående balanser obalanserade med ${ibValidation.roundingAdjustment} SEK ` +
                  `(troligen ej allokerat årets resultat från föregående räkenskapsår). ` +
                  `Differensen bokförs på konto 2099 (Årets resultat).`
                )
              } else {
                ibExplanation = 'rounding'
                result.warnings.push(
                  `Avrundningsdifferens vid SIE-import: ${ibValidation.roundingAdjustment} SEK bokförd på konto 2099`
                )
              }
            }

            openingBalancePayload = buildOpeningBalancePayload(
              parsed,
              accountMap,
              ibRoundingAdjustment,
            )
          }
        }
      }
    }

    // ── Vouchers (SIE4 only) ────────────────────────────────────────────────
    let prepared: ReturnType<typeof prepareStagedVouchers> | null = null
    if (options.importTransactions && parsed.vouchers.length > 0 && result.fiscalPeriodId) {
      // Reject vouchers whose date falls outside the resolved fiscal period.
      // Fail closed if the period fetch errors.
      const { data: resolvedPeriod, error: resolvedPeriodError } = await supabase
        .from('fiscal_periods')
        .select('period_start, period_end')
        .eq('id', result.fiscalPeriodId)
        .single()

      if (resolvedPeriodError || !resolvedPeriod) {
        result.errors.push(
          `Kunde inte verifiera räkenskapsårets datumintervall innan import: ${resolvedPeriodError?.message ?? 'räkenskapsåret hittades inte'}. Försök igen.`
        )
        await finalizeImportRecord(supabase, result.importId, companyId, result, options.fileContent)
        return result
      }

      const periodStart = resolvedPeriod.period_start as string
      const periodEnd = resolvedPeriod.period_end as string
      const outOfRange = parsed.vouchers.filter((v) => {
        const d = formatDate(v.date)
        return d < periodStart || d > periodEnd
      })

      if (outOfRange.length > 0) {
        const sample = outOfRange.slice(0, 3).map(v => `${v.series}${v.number} (${formatDate(v.date)})`).join(', ')
        result.errors.push(
          `${outOfRange.length} verifikation${outOfRange.length === 1 ? '' : 'er'} har datum utanför räkenskapsåret ` +
            `${periodStart} – ${periodEnd}. Exempel: ${sample}${outOfRange.length > 3 ? '…' : ''}. ` +
            `Importera varje räkenskapsår som en egen SIE-fil — flera år i samma fil stöds inte.`
        )
        await finalizeImportRecord(supabase, result.importId, companyId, result, options.fileContent)
        return result
      }

      // Detect partial-year export.
      if (parsed.vouchers.length > 0 && fiscalYearStart && fiscalYearEnd) {
        const voucherDates = parsed.vouchers.map(v => v.date.getTime())
        const earliestVoucher = new Date(Math.min(...voucherDates))
        const latestVoucher = new Date(Math.max(...voucherDates))
        const fyStart = new Date(fiscalYearStart + 'T00:00:00')
        const fyEnd = new Date(fiscalYearEnd + 'T00:00:00')
        const msPerDay = 86400000
        const startGap = earliestVoucher.getTime() - fyStart.getTime()
        const endGap = fyEnd.getTime() - latestVoucher.getTime()

        if (startGap > 60 * msPerDay || endGap > 60 * msPerDay) {
          result.warnings.push(
            `SIE-filen verkar innehålla ett ofullständigt räkenskapsår: verifikationer ${formatDate(earliestVoucher)}–${formatDate(latestVoucher)}, ` +
            `räkenskapsår ${fiscalYearStart}–${fiscalYearEnd}. ` +
            `Omföringsverifikationen kan bli felaktig om #UB/#RES avser hela året men verifikationerna bara täcker en del.`
          )
        }
      }

      // Ensure öresutjämning account 3741 exists in the user's chart
      await ensureAccountExists(supabase, companyId, userId, '3741', 'Öresutjämning vid import')

      // Bank-transaction overlap warning.
      if (fiscalYearStart && fiscalYearEnd) {
        try {
          const { count: overlappingTx } = await supabase
            .from('transactions')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', companyId)
            .gte('date', fiscalYearStart)
            .lte('date', fiscalYearEnd)
          if ((overlappingTx ?? 0) > 0) {
            result.warnings.push(
              `${overlappingTx} banktransaktioner finns redan i perioden ${fiscalYearStart}–${fiscalYearEnd}. ` +
              `Automatisk bokföring av dessa blockeras för att undvika dubbelbokning — använd Bankavstämning för att koppla dem mot de importerade verifikationerna.`
            )
          }
        } catch {
          // Non-critical — the bank-side overlap guard still applies.
        }
      }

      // Register SIE dimension objects (idempotent upserts).
      try {
        await syncDimensionRegisters(supabase, companyId, userId, parsed)
      } catch (dimErr) {
        result.warnings.push(
          `Dimensionsregister kunde inte synkas: ${dimErr instanceof Error ? dimErr.message : 'okänt fel'} — dimensionskoder finns ändå kvar på verifikationsraderna.`
        )
      }

      // Prepare voucher payloads with the strict difference policy (I15/I16).
      prepared = prepareStagedVouchers(parsed, accountMap, defaultSeries, policy)

      if (prepared.blockingErrors.length > 0) {
        result.errors.push(...prepared.blockingErrors)
        await finalizeImportRecord(supabase, result.importId, companyId, result, options.fileContent)
        return result
      }

      result.warnings.push(...prepared.warnings)
      voucherSeriesUsed = prepared.seriesUsed

      voucherStats = {
        total: parsed.vouchers.length,
        imported: 0, // filled after finalize
        skippedUnbalanced: prepared.skippedUnbalanced,
        skippedUnmapped: prepared.skippedUnmapped,
        skippedSingleLine: prepared.skippedSingleLine,
        skippedEmpty: prepared.skippedEmpty,
      }

      const totalSkipped = prepared.skippedEmpty + prepared.skippedSingleLine +
        prepared.skippedUnbalanced + prepared.skippedUnmapped
      if (totalSkipped > 0) {
        const parts: string[] = []
        if (prepared.skippedEmpty > 0) parts.push(`${prepared.skippedEmpty} tomma`)
        if (prepared.skippedUnbalanced > 0) parts.push(`${prepared.skippedUnbalanced} obalanserade`)
        if (prepared.skippedSingleLine > 0) parts.push(`${prepared.skippedSingleLine} enradiga`)
        result.warnings.push(
          `${totalSkipped} verifikationer hoppades över (uttryckligt godkänt): ${parts.join(', ')}`
        )
      }

      // Stage the vouchers (idempotent batches — a retry after timeout
      // re-stages only what's missing and finalize skips already-posted
      // external references, I05).
      await stageVouchers(supabase, companyId, result.importId, prepared.staged)
    }

    // ── Next-period IB resync payload (I12) ────────────────────────────────
    // Rebuild year N+1's opening balance from the imported #UB when a next
    // period exists (or should be created). The RPC enforces conflict rules
    // (IB from another source blocks) and exact continuity.
    const nextPeriodObLines = buildNextPeriodObLines(parsed, accountMap)

    // ── Atomic finalize: replace + post + OB + IB resync in ONE transaction ─
    const finalizeOptions: Record<string, unknown> = {
      skip_duplicates: true,
      expected_voucher_count: prepared ? prepared.staged.length : 0,
    }
    if (replacesImportId) finalizeOptions.replaces_import_id = replacesImportId
    if (openingBalancePayload) finalizeOptions.opening_balance = openingBalancePayload
    if (nextPeriodObLines) {
      finalizeOptions.next_period_ob = { lines: nextPeriodObLines }
      // Never auto-create N+1 here: the next period is created by year-end
      // closing or by importing year N+1 itself.
      finalizeOptions.create_next_period = false
    }

    const { data: finalizeData, error: finalizeError } = await supabase.rpc(
      'finalize_sie_import',
      {
        p_company_id: companyId,
        p_import_id: result.importId,
        p_user_id: userId,
        p_options: finalizeOptions,
      },
    )

    if (finalizeError) {
      result.errors.push(`Importen kunde inte slutföras: ${finalizeError.message}`)
      await finalizeImportRecord(supabase, result.importId, companyId, result, options.fileContent)
      return result
    }

    const finalize = finalizeData as {
      posted: number
      skipped_duplicates: number
      deleted_from_replaced: number
      opening_balance_entry_id: string | null
      next_period_opening_balance_entry_id: string | null
      next_period_id: string | null
    }

    if (replacesImportId) {
      result.replacedPriorImport = {
        importId: replacesImportId,
        reversedEntries: finalize.deleted_from_replaced,
      }
    }
    if (finalize.opening_balance_entry_id) {
      result.openingBalanceEntryId = finalize.opening_balance_entry_id
      result.journalEntriesCreated++
      result.journalEntryIds.push(finalize.opening_balance_entry_id)
    }
    if (finalize.next_period_opening_balance_entry_id && finalize.next_period_id) {
      result.nextPeriodIBResync = {
        nextPeriodId: finalize.next_period_id,
        nextPeriodName: '',
        stornoEntryId: '',
        newOpeningBalanceEntryId: finalize.next_period_opening_balance_entry_id,
      }
      result.journalEntriesCreated++
      result.journalEntryIds.push(finalize.next_period_opening_balance_entry_id)
      result.warnings.push(
        'Ingående balanser för nästa räkenskapsår synkades mot den importerade utgående balansen.',
      )
    }

    result.journalEntriesCreated += finalize.posted
    voucherStats.imported = finalize.posted
    if (finalize.skipped_duplicates > 0) {
      result.warnings.push(
        `${finalize.skipped_duplicates} verifikationer var redan bokförda för denna import och hoppades över (idempotent återkörning).`
      )
    }

    // Fetch the posted entries for ids + voucher number mapping documentation.
    const postedEntries = await fetchAllRows<{
      id: string
      voucher_series: string
      voucher_number: number
      external_reference: string | null
      source_voucher_series: string | null
      source_voucher_number: number | null
      source_type: string
    }>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id, voucher_series, voucher_number, external_reference, source_voucher_series, source_voucher_number, source_type')
        .eq('company_id', companyId)
        .eq('sie_import_id', result.importId!)
        .order('voucher_number', { ascending: true })
        .range(from, to),
    )
    for (const e of postedEntries) {
      if (e.source_type === 'opening_balance' && e.external_reference === 'opening_balance') continue
      result.journalEntryIds.push(e.id)
      voucherNumberMapping.push({
        sourceId: `${e.source_voucher_series ?? ''}${e.source_voucher_number ?? ''}`,
        series: e.voucher_series,
        targetNumber: e.voucher_number,
      })
    }

    // ── Migration adjustment (I16): only with explicit attest ───────────────
    const totalSkippedForAdjustment = prepared
      ? prepared.skippedUnbalanced + prepared.skippedSingleLine
      : 0
    if (totalSkippedForAdjustment > 0 && result.fiscalPeriodId && prepared) {
      if (options.approveMigrationAdjustment) {
        try {
          const adjustment = await createMigrationAdjustmentEntry(
            supabase,
            companyId,
            userId,
            result.fiscalPeriodId,
            result.importId!,
            options.approveOreRounding ?? false,
            parsed,
            accountMap,
            prepared.movementsByAccount,
            prepared.skippedDetails
          )

          result.warnings.push(...adjustment.warnings)

          if (adjustment.entryId) {
            result.journalEntriesCreated++
            result.journalEntryIds.push(adjustment.entryId)
            result.warnings.push(
              `Migreringsjustering skapad efter uttryckligt godkännande: ${adjustment.deltaAccounts} konton justerade för att matcha UB/RES från källsystemet`
            )
            migrationAdjustmentInfo = {
              created: true,
              deltaAccounts: adjustment.deltaAccounts,
              entryId: adjustment.entryId,
            }
          }
        } catch (adjustmentError) {
          console.error('[sie-import] Failed to create migration adjustment entry:', adjustmentError)
          const message = adjustmentError instanceof Error
            ? adjustmentError.message
            : 'Okänt fel vid migreringsjustering'
          result.warnings.push(
            `Migreringsjustering skapades inte: ${message} Kontrollera saldon manuellt mot källsystemet.`
          )
        }
      } else {
        // No fabricated compensation without attest (I16): surface the exact
        // situation and the recommended action instead.
        result.warnings.push(
          `${totalSkippedForAdjustment} verifikationer hoppades över utan kompensationsverifikation. ` +
          `Utgående balans kan avvika från källsystemet — granska differenserna i importdetaljerna och ` +
          `godkänn en migreringsjustering uttryckligen (approve_migration_adjustment) om den behövs.`
        )
      }
    }

    // Save account mappings for future use (non-fatal)
    try {
      await saveMappings(supabase, companyId, mappings)
    } catch (mappingError) {
      console.error('[sie-import] Failed to save mappings (non-fatal):', mappingError)
      result.warnings.push('Kunde inte spara kontomappningar — påverkar inte importerade data')
    }

    // Generate systemdokumentation (MigrationDocumentation)
    const mappingStats = getMappingStats(mappings)
    const documentation: MigrationDocumentation = {
      sourceSystem: parsed.header.program,
      sourceVersion: parsed.header.programVersion,
      sieType: parsed.header.sieType,
      generatedDate: parsed.header.generatedDate ?? null,
      fiscalYear: {
        start: fiscalYearStart,
        end: fiscalYearEnd,
      },
      importedAt: new Date().toISOString(),
      importedBy: userId,
      accountMappings: {
        total: mappingStats.total,
        exact: mappingStats.exact,
        basRange: mappingStats.basRange,
        manual: mappingStats.manual,
        unmapped: mappingStats.unmapped,
      },
      accountRenames:
        accountSync.renamedAccounts.length > 0 ? accountSync.renamedAccounts : undefined,
      vouchers: voucherStats,
      openingBalanceRounding: ibRoundingAdjustment !== 0 ? ibRoundingAdjustment : null,
      migrationAdjustment: migrationAdjustmentInfo,
      voucherSeriesUsed: voucherSeriesUsed.length > 0 ? voucherSeriesUsed : [defaultSeries],
      voucherNumberRanges: computeVoucherNumberRanges(voucherNumberMapping),
      voucherNumberMapping,
    }

    // Populate structured details for the UI
    const totalSkippedForDetails = voucherStats.skippedUnbalanced + voucherStats.skippedUnmapped +
      voucherStats.skippedSingleLine + voucherStats.skippedEmpty
    result.details = {
      fiscalYear: fiscalYearStart && fiscalYearEnd
        ? { start: fiscalYearStart, end: fiscalYearEnd }
        : undefined,
      skippedVouchers: totalSkippedForDetails > 0 ? {
        unbalanced: voucherStats.skippedUnbalanced,
        unmapped: voucherStats.skippedUnmapped,
        singleLine: voucherStats.skippedSingleLine,
        empty: voucherStats.skippedEmpty,
        total: totalSkippedForDetails,
      } : undefined,
      openingBalance: ibRoundingAdjustment !== 0 ? {
        imbalance: ibRoundingAdjustment,
        explanation: ibExplanation,
        bookedToAccount: '2099',
      } : undefined,
      migrationAdjustment: migrationAdjustmentInfo.created ? {
        created: true,
        accountsAdjusted: migrationAdjustmentInfo.deltaAccounts,
      } : undefined,
      retriedBatches: 0,
      failedBatches: 0,
    }

    // Add warnings for any parser issues BEFORE finalizing so the persisted
    // warning list and the API response are the same final list (I24).
    for (const issue of parsed.issues) {
      if (issue.severity === 'warning') {
        result.warnings.push(`Line ${issue.line}: ${issue.message}`)
      }
    }

    result.success = result.errors.length === 0

    // Finalize the import record: archive the original file FIRST (I18),
    // then flip the status through the controlled complete_sie_import RPC
    // (I17) with the final warning list (I24).
    await finalizeImportRecord(
      supabase,
      result.importId,
      companyId,
      result,
      options.fileContent,
      documentation
    )

    // Populate counterparty templates from voucher patterns (non-blocking)
    if (result.success && parsed.vouchers.length > 0) {
      try {
        const templateCount = await populateTemplatesFromSieVouchers(
          supabase, companyId, parsed.vouchers
        )
        if (templateCount > 0) {
          console.info(`[sie-import] ${templateCount} counterparty templates extracted from voucher history`)
        }
      } catch (templateError) {
        console.error('[sie-import] Failed to populate counterparty templates:', templateError)
      }
    }

  } catch (error) {
    result.errors.push(
      `Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    )

    // Mark the pending import as failed if we created one
    if (result.importId) {
      try {
        await finalizeImportRecord(
          supabase,
          result.importId,
          companyId,
          result,
          options.fileContent
        )
      } catch (finalizeError) {
        console.error('[sie-import] Failed to finalize import record on error:', finalizeError)
      }
    }
  }

  return result
}
