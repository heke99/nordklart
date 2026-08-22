import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
  JournalEntryLine,
} from '@/types'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotReverseNonPostedError,
  EntryAlreadyReversedError,
  JournalEntryNotFoundError,
  TargetPeriodLockedError,
} from '@/lib/bookkeeping/errors'
import { roundOre } from '@/lib/money'

/**
 * A voucher plan as reverse_journal_entry_v2 consumes it. `source_id` is
 * explicitly nullable because the RPC compares it with `nullif(...)`, so an
 * absent key and an explicit null must mean the same thing.
 */
export type StornoJournalPlan = Omit<CreateJournalEntryInput, 'source_id'> & {
  voucher_series: string
  source_id: string | null
}

/**
 * Storno / rättelse planning and RPC error translation.
 *
 * Both reverseEntry() (engine) and correctEntry() (storno-service) hand
 * reverse_journal_entry_v2 a plan and let PostgreSQL persist it inside one
 * transaction. The line derivation stays here, in TypeScript, so there is a
 * single definition of what a storno line is — restating it in PL/pgSQL would
 * create a second domain truth, which this project's rules forbid.
 */

/** Swap debit and credit, negate the currency amount, keep every dimension. */
export function planReversalLines(lines: JournalEntryLine[]): CreateJournalEntryLineInput[] {
  return lines.map((line) => ({
    account_number: line.account_number,
    debit_amount: roundOre(Number(line.credit_amount) || 0),
    credit_amount: roundOre(Number(line.debit_amount) || 0),
    line_description: `Storno: ${line.line_description || ''}`,
    currency: line.currency || 'SEK',
    ...(line.amount_in_currency
      ? { amount_in_currency: -roundOre(Number(line.amount_in_currency)) }
      : {}),
    ...(line.exchange_rate ? { exchange_rate: Number(line.exchange_rate) } : {}),
    ...(line.tax_code ? { tax_code: line.tax_code } : {}),
    ...(line.cost_center ? { cost_center: line.cost_center } : {}),
    ...(line.project ? { project: line.project } : {}),
  }))
}

/**
 * The storno voucher plan. It always lands in the ORIGINAL's fiscal period —
 * a storno that nets somewhere else does not cancel anything where it was
 * booked.
 */
export function planReversalJournal(
  original: JournalEntry,
  lines: JournalEntryLine[],
  entryDate: string,
  descriptionPrefix: 'Storno' | 'Makulering' = 'Storno',
): StornoJournalPlan {
  return {
    fiscal_period_id: original.fiscal_period_id,
    entry_date: entryDate,
    description: `${descriptionPrefix}: ${original.description}`,
    source_type: 'storno',
    source_id: original.source_id ?? null,
    voucher_series: original.voucher_series || 'A',
    lines: planReversalLines(lines),
  }
}

/** The rättelse voucher plan — the caller's proposed lines, verbatim. */
export function planCorrectionJournal(
  original: JournalEntry,
  correctedLines: CreateJournalEntryLineInput[],
  fiscalPeriodId: string,
  entryDate: string,
): StornoJournalPlan {
  return {
    fiscal_period_id: fiscalPeriodId,
    entry_date: entryDate,
    description: `Rättelse: ${original.description}`,
    source_type: 'correction',
    source_id: null,
    voucher_series: original.voucher_series || 'A',
    lines: correctedLines.map((line) => ({
      ...line,
      debit_amount: roundOre(line.debit_amount || 0),
      credit_amount: roundOre(line.credit_amount || 0),
      ...(line.amount_in_currency
        ? { amount_in_currency: roundOre(line.amount_in_currency) }
        : {}),
    })),
  }
}

/** Domain code carried in the RPC's DETAIL payload, when there is one. */
export function stornoRpcDomainCode(error: unknown): string | null {
  const candidate = error as { details?: string } | null
  if (!candidate?.details) return null
  try {
    return (JSON.parse(candidate.details) as { code?: string }).code ?? null
  } catch {
    return candidate.details.match(/"code"\s*:\s*"([A-Z0-9_]+)"/)?.[1] ?? null
  }
}

/**
 * Turn a reverse_journal_entry_v2 failure back into the typed error the
 * existing callers and route handlers already translate. The RPC rolls its
 * whole transaction back, so there is never anything to compensate on this
 * path — unlike the multi-write version it replaces.
 */
export function translateStornoRpcError(
  error: unknown,
  operation: 'create_reversal_entry' | 'create_corrected_entry',
): Error {
  const code = stornoRpcDomainCode(error)
  switch (code) {
    case 'ENTRY_ALREADY_REVERSED':
      return new EntryAlreadyReversedError()
    case 'JOURNAL_ENTRY_NOT_FOUND':
      return new JournalEntryNotFoundError()
    case 'CANNOT_REVERSE_NON_POSTED':
      return new CannotReverseNonPostedError('unknown')
    case 'PERIOD_LOCKED':
      return new TargetPeriodLockedError('', null)
    case 'ACCOUNTS_NOT_IN_CHART':
      return new AccountsNotInChartError([])
    default:
      return new BookkeepingDatabaseError(
        operation,
        (error as { message?: string } | null)?.message,
      )
  }
}
