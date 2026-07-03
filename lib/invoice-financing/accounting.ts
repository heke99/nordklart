import type { SupabaseClient } from '@supabase/supabase-js'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { roundOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'
import type { CreateJournalEntryLineInput, JournalEntry } from '@/types'

const log = createLogger('invoice-financing-accounting')

/**
 * Invoice-financing bookkeeping (fakturaförsäljning / fakturabelåning).
 *
 * Non-recourse (fakturaförsäljning — the receivable is SOLD):
 *   Dr 1930 Företagskonto        [payout]
 *   Dr 6064 Factoringavgifter    [fee]
 *   Cr 1510 Kundfordringar       [full invoice amount]
 *
 * Recourse (fakturabelåning — borrowing against the receivable):
 *   Dr 1512 Belånade kundfordringar / Cr 1510   [full amount, reclass]
 *   Dr 1930 Företagskonto        [payout]
 *   Dr 6064 Factoringavgifter    [fee]
 *   Cr 2330 Factoringkredit      [payout + fee]
 *
 * VAT: the financing fee is a financial service (undantagen från moms,
 *  ML 10 kap) — no VAT lines, and the original invoice's output VAT is
 * untouched (it was reported when the invoice was issued).
 */

export function buildNonRecourseLines(args: {
  invoiceAmount: number
  payoutAmount: number
  feeAmount: number
  invoiceTag: string
}): CreateJournalEntryLineInput[] {
  const invoiceAmount = roundOre(args.invoiceAmount)
  const payout = roundOre(args.payoutAmount)
  const fee = roundOre(args.feeAmount)
  if (roundOre(payout + fee) !== invoiceAmount) {
    throw new Error(
      `Fakturaförsäljningen balanserar inte: utbetalning ${payout} + avgift ${fee} ≠ fakturabelopp ${invoiceAmount}.`,
    )
  }
  return [
    {
      account_number: '1930',
      debit_amount: payout,
      credit_amount: 0,
      line_description: `Fakturaförsäljning ${args.invoiceTag} — utbetalning`,
    },
    {
      account_number: '6064',
      debit_amount: fee,
      credit_amount: 0,
      line_description: `Factoringavgift ${args.invoiceTag}`,
    },
    {
      account_number: '1510',
      debit_amount: 0,
      credit_amount: invoiceAmount,
      line_description: `Såld kundfordran ${args.invoiceTag}`,
    },
  ]
}

export function buildRecourseLines(args: {
  invoiceAmount: number
  payoutAmount: number
  feeAmount: number
  invoiceTag: string
}): CreateJournalEntryLineInput[] {
  const invoiceAmount = roundOre(args.invoiceAmount)
  const payout = roundOre(args.payoutAmount)
  const fee = roundOre(args.feeAmount)
  const credit = roundOre(payout + fee)
  return [
    // Reclass the receivable so the balance sheet shows it as pledged.
    {
      account_number: '1512',
      debit_amount: invoiceAmount,
      credit_amount: 0,
      line_description: `Belånad kundfordran ${args.invoiceTag}`,
    },
    {
      account_number: '1510',
      debit_amount: 0,
      credit_amount: invoiceAmount,
      line_description: `Belånad kundfordran ${args.invoiceTag} (omklassificering)`,
    },
    // The loan payout + fee.
    {
      account_number: '1930',
      debit_amount: payout,
      credit_amount: 0,
      line_description: `Fakturabelåning ${args.invoiceTag} — utbetalning`,
    },
    {
      account_number: '6064',
      debit_amount: fee,
      credit_amount: 0,
      line_description: `Factoringavgift ${args.invoiceTag}`,
    },
    {
      account_number: '2330',
      debit_amount: 0,
      credit_amount: credit,
      line_description: `Factoringkredit ${args.invoiceTag}`,
    },
  ]
}

/**
 * Book the financing payout. Returns the journal entry or null when no open
 * fiscal period covers the payout date (caller surfaces the warning; the
 * financing status is still advanced — booking can be redone manually).
 */
export async function createFinancingPayoutEntry(
  supabase: SupabaseClient,
  args: {
    companyId: string
    userId: string
    invoiceId: string
    invoiceTag: string
    invoiceAmount: number
    payoutAmount: number
    feeAmount: number
    recourse: boolean
    payoutDate: string
  },
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, args.companyId, args.payoutDate)
  if (!fiscalPeriodId) {
    log.warn('no open fiscal period for financing payout', { payoutDate: args.payoutDate })
    return null
  }

  const lines = args.recourse
    ? buildRecourseLines(args)
    : buildNonRecourseLines(args)

  return createJournalEntry(supabase, args.companyId, args.userId, {
    fiscal_period_id: fiscalPeriodId,
    entry_date: args.payoutDate,
    description: args.recourse
      ? `Fakturabelåning ${args.invoiceTag}`
      : `Fakturaförsäljning ${args.invoiceTag}`,
    source_type: 'manual',
    source_id: args.invoiceId,
    lines,
  })
}
