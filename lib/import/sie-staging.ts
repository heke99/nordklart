import type { SupabaseClient } from '@supabase/supabase-js'
import type { ParsedSIEFile } from './types'
import { getEffectiveOpeningBalances, isBalanceSheetAccount } from './sie-parser'
import type { CreateJournalEntryLineInput } from '@/types'

/**
 * SIE voucher staging (revision items I01–I06, I11, I12, I15, I16).
 *
 * The old importer wrote journal_entries directly with status 'posted',
 * bypassing every engine validation. The new flow:
 *
 *   1. prepareStagedVouchers() — pure validation + payload building with a
 *      STRICT difference policy (I15): öre differences ≤ 1 öre get an
 *      explicit öresutjämning line; anything larger requires the caller's
 *      explicit, reviewed approval or blocks the import. Nothing is silently
 *      auto-adjusted and no voucher is silently skipped.
 *   2. stageVouchers() — idempotent batch writes to sie_import_staging
 *      (retry-safe: primary key (import_id, row_index)).
 *   3. finalize_sie_import RPC — posts everything in ONE database
 *      transaction through the same validation path as the engine
 *      (balance, period, company, debit/kredit, sequential voucher numbers,
 *      posted only after checks — I01–I03), including precise replace of a
 *      prior import (I06) and the N→N+1 opening balance resync (I12).
 */

const round2 = (x: number): number => Math.round(x * 100) / 100

/** Auto-adjusted öresutjämning tolerance: 1 öre (documented, I15). */
export const SIE_ORE_AUTO_TOLERANCE = 0.01
/** Maximum difference that MAY be approved for öresutjämning: 1 SEK. */
export const SIE_ORE_APPROVAL_CAP = 1.0

export interface SieImportPolicy {
  /** Explicitly approve öresutjämning (3741) for diffs in (0.01, 1.00] SEK. */
  approveOreRounding: boolean
  /** Explicitly approve skipping unpostable vouchers (unbalanced > 1 SEK,
   *  single-line). Without approval such vouchers BLOCK the import. */
  approveSkippedVouchers: boolean
}

export interface StagedVoucherPayload {
  external_reference: string
  voucher_series: string
  entry_date: string
  description: string
  source_type: 'import' | 'opening_balance'
  source_voucher_series: string | null
  source_voucher_number: number | null
  lines: Array<{
    account_number: string
    debit_amount: number
    credit_amount: number
    line_description: string | null
    cost_center: string | null
    project: string | null
    dimensions: Record<string, string> | null
  }>
}

export interface SkippedVoucherDetail {
  voucherId: string
  date: string
  description: string
  reason: 'unmapped' | 'empty' | 'unbalanced' | 'zero_lines' | 'single_line'
  unmappedAccounts?: string[]
  balanceDiff?: number
  totalDebit?: number
  totalCredit?: number
  sourceLines?: { account: string; amount: number }[]
  mappedLineCount?: number
  originalLineCount?: number
}

export interface PreparedVouchers {
  staged: StagedVoucherPayload[]
  /** Non-empty ⇒ the import must be blocked (I15/I16). */
  blockingErrors: string[]
  warnings: string[]
  skippedEmpty: number
  skippedSingleLine: number
  skippedUnbalanced: number
  skippedUnmapped: number
  skippedDetails: SkippedVoucherDetail[]
  /** Net movement per target account for the vouchers that WILL be posted. */
  movementsByAccount: Map<string, number>
  seriesUsed: string[]
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const OPENING_BALANCE_DESCRIPTION_RE =
  /ingående\s+balans|ing\.?\s*balans|\bIB\b|öppningsbalans|opening\s+balance/i
const SHARE_CAPITAL_DESCRIPTION_RE = /aktiekapital|insättning\s+aktiekapital/i

/**
 * Validate + build the staged voucher payloads with the strict difference
 * policy (I15/I16). Pure — no database access.
 */
export function prepareStagedVouchers(
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>,
  defaultSeries: string,
  policy: SieImportPolicy,
): PreparedVouchers {
  const result: PreparedVouchers = {
    staged: [],
    blockingErrors: [],
    warnings: [],
    skippedEmpty: 0,
    skippedSingleLine: 0,
    skippedUnbalanced: 0,
    skippedUnmapped: 0,
    skippedDetails: [],
    movementsByAccount: new Map(),
    seriesUsed: [],
  }

  const hasCurrentYearIb = getEffectiveOpeningBalances(parsed).balances.length > 0
  const fyStart = parsed.stats.fiscalYearStart
  const seriesSet = new Set<string>()

  for (const voucher of parsed.vouchers) {
    const voucherId = `${voucher.series}${voucher.number}`
    const voucherDate = formatDate(voucher.date)

    const lines: StagedVoucherPayload['lines'] = []
    const unmappedAccountSet = new Set<string>()

    for (const line of voucher.lines) {
      const targetAccount = accountMap.get(line.account)
      if (!targetAccount) {
        unmappedAccountSet.add(line.account)
        continue
      }

      let costCenter: string | null = null
      let project: string | null = null
      let dimensionsMap: Record<string, string> | null = null
      if (line.objectList && line.objectList.length > 0) {
        dimensionsMap = {}
        for (const ref of line.objectList) {
          dimensionsMap[ref.dimension] = ref.code
          if (ref.dimension === '1') costCenter = ref.code
          if (ref.dimension === '6') project = ref.code
        }
      }

      if (line.amount > 0) {
        lines.push({
          account_number: targetAccount,
          debit_amount: round2(line.amount),
          credit_amount: 0,
          line_description: line.description || null,
          cost_center: costCenter,
          project,
          dimensions: dimensionsMap,
        })
      } else if (line.amount < 0) {
        lines.push({
          account_number: targetAccount,
          debit_amount: 0,
          credit_amount: round2(Math.abs(line.amount)),
          line_description: line.description || null,
          cost_center: costCenter,
          project,
          dimensions: dimensionsMap,
        })
      }
      // lines with amount === 0 carry no financial content and are dropped
    }

    // Unmapped accounts BLOCK the import (I15): silently skipping financial
    // vouchers would corrupt the migrated year.
    if (unmappedAccountSet.size > 0) {
      result.skippedUnmapped++
      result.skippedDetails.push({
        voucherId,
        date: voucherDate,
        description: voucher.description,
        reason: 'unmapped',
        unmappedAccounts: [...unmappedAccountSet],
        mappedLineCount: lines.length,
        originalLineCount: voucher.lines.length,
        sourceLines: voucher.lines.map((l) => ({ account: l.account, amount: l.amount })),
      })
      result.blockingErrors.push(
        `Verifikation ${voucherId} (${voucherDate}) har konton utan mappning: ${[...unmappedAccountSet].join(', ')}. Mappa kontona och försök igen.`,
      )
      continue
    }

    // Empty vouchers (no financial content) — skip with warning.
    if (lines.length === 0) {
      result.skippedEmpty++
      result.skippedDetails.push({
        voucherId,
        date: voucherDate,
        description: voucher.description,
        reason: 'zero_lines',
        mappedLineCount: 0,
        originalLineCount: voucher.lines.length,
        sourceLines: voucher.lines.map((l) => ({ account: l.account, amount: l.amount })),
      })
      continue
    }

    const totalDebit = round2(lines.reduce((s, l) => s + l.debit_amount, 0))
    const totalCredit = round2(lines.reduce((s, l) => s + l.credit_amount, 0))
    const balanceDiff = round2(Math.abs(totalDebit - totalCredit))

    // Single-line vouchers cannot balance — treat under the skip policy.
    if (lines.length === 1) {
      result.skippedSingleLine++
      result.skippedDetails.push({
        voucherId,
        date: voucherDate,
        description: voucher.description,
        reason: 'single_line',
        mappedLineCount: 1,
        originalLineCount: voucher.lines.length,
        sourceLines: voucher.lines.map((l) => ({ account: l.account, amount: l.amount })),
      })
      if (policy.approveSkippedVouchers) {
        result.warnings.push(
          `Verifikation ${voucherId} (${voucherDate}) har endast en rad och hoppades över efter uttryckligt godkännande.`,
        )
      } else {
        result.blockingErrors.push(
          `Verifikation ${voucherId} (${voucherDate}) har endast en bokföringsrad och kan inte bokföras balanserat. Granska och godkänn överhoppning uttryckligen (approve_skipped_vouchers) eller rätta filen.`,
        )
      }
      continue
    }

    if (balanceDiff > SIE_ORE_APPROVAL_CAP) {
      // > 1 SEK difference — incomplete voucher in the source system.
      result.skippedUnbalanced++
      result.skippedDetails.push({
        voucherId,
        date: voucherDate,
        description: voucher.description,
        reason: 'unbalanced',
        balanceDiff,
        totalDebit,
        totalCredit,
        mappedLineCount: lines.length,
        originalLineCount: voucher.lines.length,
        sourceLines: voucher.lines.map((l) => ({ account: l.account, amount: l.amount })),
      })
      if (policy.approveSkippedVouchers) {
        result.warnings.push(
          `Verifikation ${voucherId} (${voucherDate}) är obalanserad med ${balanceDiff} kr och hoppades över efter uttryckligt godkännande.`,
        )
      } else {
        result.blockingErrors.push(
          `Verifikation ${voucherId} (${voucherDate}) är obalanserad: debet ${totalDebit} kr, kredit ${totalCredit} kr (differens ${balanceDiff} kr). Differenser över öresavrundning blockerar importen (I15) — rätta filen eller godkänn överhoppning uttryckligen.`,
        )
      }
      continue
    }

    if (balanceDiff > 0.005) {
      // Öresutjämning territory. ≤ 1 öre is the documented automatic
      // tolerance; (1 öre, 1 SEK] requires explicit approval (I15).
      if (balanceDiff > SIE_ORE_AUTO_TOLERANCE && !policy.approveOreRounding) {
        result.skippedUnbalanced++
        result.skippedDetails.push({
          voucherId,
          date: voucherDate,
          description: voucher.description,
          reason: 'unbalanced',
          balanceDiff,
          totalDebit,
          totalCredit,
          mappedLineCount: lines.length,
          originalLineCount: voucher.lines.length,
          sourceLines: voucher.lines.map((l) => ({ account: l.account, amount: l.amount })),
        })
        result.blockingErrors.push(
          `Verifikation ${voucherId} (${voucherDate}) har en öresdifferens på ${balanceDiff} kr (över den automatiska toleransen 0,01 kr). Godkänn öresutjämning uttryckligen (approve_ore_rounding) för att bokföra differensen på konto 3741.`,
        )
        continue
      }

      const signedDiff = round2(totalDebit - totalCredit)
      lines.push({
        account_number: '3741',
        debit_amount: signedDiff > 0 ? 0 : Math.abs(signedDiff),
        credit_amount: signedDiff > 0 ? Math.abs(signedDiff) : 0,
        line_description: 'Öresutjämning',
        cost_center: null,
        project: null,
        dimensions: null,
      })
      if (balanceDiff > SIE_ORE_AUTO_TOLERANCE) {
        result.warnings.push(
          `Verifikation ${voucherId}: öresutjämning ${balanceDiff} kr bokförd på konto 3741 efter uttryckligt godkännande.`,
        )
      }
    }

    const resolvedSeries =
      voucher.series && voucher.series.trim() ? voucher.series.trim() : defaultSeries
    const rawSourceSeries =
      voucher.series && voucher.series.trim() ? voucher.series.trim() : null
    const rawSourceNumber = Number.isFinite(voucher.number) ? voucher.number : null

    const isLikelyOpeningBalance =
      !hasCurrentYearIb &&
      !!fyStart &&
      fyStart.slice(0, 10) === voucherDate &&
      lines.length > 0 &&
      lines.every((l) => isBalanceSheetAccount(l.account_number)) &&
      OPENING_BALANCE_DESCRIPTION_RE.test(voucher.description || '') &&
      !SHARE_CAPITAL_DESCRIPTION_RE.test(voucher.description || '')

    seriesSet.add(resolvedSeries)

    for (const line of lines) {
      const net = line.debit_amount - line.credit_amount
      result.movementsByAccount.set(
        line.account_number,
        (result.movementsByAccount.get(line.account_number) || 0) + net,
      )
    }

    result.staged.push({
      external_reference: `${voucher.series || defaultSeries}:${voucher.number}:${voucherDate}`,
      voucher_series: resolvedSeries,
      entry_date: voucherDate,
      description: voucher.description || `Import: ${voucherId}`,
      source_type: isLikelyOpeningBalance ? 'opening_balance' : 'import',
      source_voucher_series: rawSourceSeries,
      source_voucher_number: rawSourceNumber,
      lines,
    })
  }

  result.seriesUsed = [...seriesSet]
  return result
}

/**
 * Stage the prepared vouchers in resumable batches. Primary key
 * (import_id, row_index) makes retries idempotent (I05); the checkpoint on
 * sie_imports records the last completed batch.
 */
export async function stageVouchers(
  supabase: SupabaseClient,
  companyId: string,
  importId: string,
  staged: StagedVoucherPayload[],
): Promise<void> {
  const BATCH_SIZE = 200
  for (let i = 0; i < staged.length; i += BATCH_SIZE) {
    const batch = staged.slice(i, i + BATCH_SIZE).map((voucher, j) => ({
      import_id: importId,
      company_id: companyId,
      row_index: i + j,
      voucher,
    }))

    const { error } = await supabase
      .from('sie_import_staging')
      .upsert(batch, { onConflict: 'import_id,row_index', ignoreDuplicates: true })

    if (error) {
      throw new Error(`Kunde inte mellanlagra verifikationer (batch ${i / BATCH_SIZE + 1}): ${error.message}`)
    }

    const { error: checkpointError } = await supabase
      .from('sie_imports')
      .update({
        status: 'staged',
        total_vouchers: staged.length,
        last_checkpoint: { staged_through: Math.min(i + BATCH_SIZE, staged.length) },
      })
      .eq('id', importId)
      .eq('company_id', companyId)
    if (checkpointError) {
      throw new Error(`Kunde inte spara import-checkpoint: ${checkpointError.message}`)
    }
  }
}

export interface OpeningBalancePayload {
  entry_date: string
  description: string
  lines: CreateJournalEntryLineInput[]
}

/**
 * Build the next-period opening balance from the just-imported year's #UB
 * (yearIndex 0), for the N→N+1 resync inside finalize_sie_import (I12).
 * Returns null when the file carries no current-year closing balances.
 */
export function buildNextPeriodObLines(
  parsed: ParsedSIEFile,
  accountMap: Map<string, string>,
): CreateJournalEntryLineInput[] | null {
  const currentYearUB = parsed.closingBalances.filter((b) => b.yearIndex === 0)
  if (currentYearUB.length === 0) return null

  const lines: CreateJournalEntryLineInput[] = []
  for (const balance of currentYearUB) {
    const targetAccount = accountMap.get(balance.account) ?? balance.account
    if (balance.amount > 0) {
      lines.push({
        account_number: targetAccount,
        debit_amount: balance.amount,
        credit_amount: 0,
        line_description: `IB ${balance.account} (från föregående års UB)`,
      })
    } else if (balance.amount < 0) {
      lines.push({
        account_number: targetAccount,
        debit_amount: 0,
        credit_amount: Math.abs(balance.amount),
        line_description: `IB ${balance.account} (från föregående års UB)`,
      })
    }
  }

  if (lines.length === 0) return null

  const totalDebit = lines.reduce((s, l) => s + l.debit_amount, 0)
  const totalCredit = lines.reduce((s, l) => s + l.credit_amount, 0)
  const diff = round2(totalDebit - totalCredit)
  if (Math.abs(diff) > 0.005) {
    lines.push({
      account_number: '2099',
      debit_amount: diff > 0 ? 0 : Math.abs(diff),
      credit_amount: diff > 0 ? diff : 0,
      line_description: 'Avrundningsdifferens vid IB-synk från SIE-import',
    })
  }

  return lines
}
