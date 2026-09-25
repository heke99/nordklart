import type { SupabaseClient } from '@supabase/supabase-js'
import { createDraftEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { generateResultAppropriation } from '@/lib/core/bookkeeping/result-appropriation-service'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput, JournalEntry } from '@/types'

const log = createLogger('dividend-service')

/**
 * Vinstutdelning i aktiebolag — booking the stämma's decision and the payout.
 *
 * Legal frame (aktiebolagslagen 2005:551, verified against the statute text):
 *  - 18 kap. 1 §: the bolagsstämma decides; it may not decide more than the
 *    board proposed unless the bolagsordning requires it or a minority
 *    demands it under 18:11.
 *  - 17 kap. 3 § första stycket (beloppsspärren): after the dividend there
 *    must be full coverage for the restricted equity, computed on the latest
 *    adopted balance sheet with regard to later changes in restricted equity.
 *  - 17 kap. 3 § andra stycket (försiktighetsregeln): the dividend must also
 *    be justifiable given the business's equity needs, consolidation,
 *    liquidity and position. That is a judgement the board makes in its
 *    motivated statement (18 kap. 4 §); we compute the key figures and warn.
 *  - 18 kap. 3 och 13 §§: the decision states the amount per share and, in a
 *    non-avstämningsbolag, when it is paid (at the latest the day before the
 *    next årsstämma).
 *
 * Accounting (BAS; Bokio, Fortnox and Björn Lundén guides agree):
 *  - at the stämma: Dr 2098 Vinst eller förlust från föregående år (and 2091
 *    Balanserad vinst for any part not covered by 2098), Cr 2898 Outtagen
 *    vinstutdelning; the rest of 2098 is "balanseras i ny räkning", i.e. moved
 *    to 2091. We book both in one voucher dated the stämma day.
 *  - at payout: Dr 2898, Cr 1930 (or another 19xx cash account).
 *
 * Tax reporting: the company files kontrolluppgift KU31 for the dividend
 * (Skatteverket), marking field 061 for a fåmansföretag's företagsledare,
 * närstående or delägare (SFL 24 kap. 4 § 3), by 31 January of the year after
 * the dividend became available (SFL 24 kap. 1 §). In a kupongbolag the
 * dividend is available on the stämma day unless the stämma decided another
 * payment day (Skatteverket, KU31). A kupongbolag withholds no preliminary tax
 * on dividends to Swedish residents; dividends to recipients resident abroad
 * carry 30 % kupongskatt (kupongskattelagen), which is not booked here.
 *
 * The database (book_dividend_decision / book_dividend_payment,
 * 20260925130000) re-checks every rule under a lock and commits the voucher
 * atomically with the decision; this module only builds the drafts.
 */

export const DIVIDEND_ACCOUNTS = {
  retainedEarnings: '2091',
  priorYearResult: '2098',
  dividendPayable: '2898',
  bank: '1930',
} as const

export type DividendErrorCode =
  | 'DIVIDEND_PROPOSAL_NOT_FOUND'
  | 'DIVIDEND_PROPOSAL_NOT_APPROVED'
  | 'DIVIDEND_ALREADY_DECIDED'
  | 'DIVIDEND_DECISION_BEFORE_BALANCE_DATE'
  | 'DIVIDEND_ANNUAL_REPORT_NOT_ADOPTED'
  | 'DIVIDEND_AMOUNT_INVALID'
  | 'DIVIDEND_EXCEEDS_BOARD_PROPOSAL'
  | 'DIVIDEND_EXCEEDS_DISTRIBUTABLE'
  | 'DIVIDEND_PAYMENT_DATE_INVALID'
  | 'DIVIDEND_DRAFT_INVALID'
  | 'DIVIDEND_PRIOR_RESULT_NOT_TRANSFERRED'
  | 'DIVIDEND_DECISION_NOT_FOUND'
  | 'DIVIDEND_OVERPAID'
  | 'DIVIDEND_NO_OPEN_PERIOD'

export const DIVIDEND_ERROR_MESSAGES_SV: Record<DividendErrorCode, string> = {
  DIVIDEND_PROPOSAL_NOT_FOUND: 'Utdelningsförslaget hittades inte.',
  DIVIDEND_PROPOSAL_NOT_APPROVED: 'Utdelningsförslaget är inte godkänt för årsredovisningen.',
  DIVIDEND_ALREADY_DECIDED: 'Stämmans beslut om utdelning är redan bokfört.',
  DIVIDEND_DECISION_BEFORE_BALANCE_DATE: 'Beslutsdatum måste infalla efter balansdagen.',
  DIVIDEND_ANNUAL_REPORT_NOT_ADOPTED:
    'Årsredovisningen måste vara fastställd på årsstämman (senast beslutsdagen) innan utdelning kan beslutas.',
  DIVIDEND_AMOUNT_INVALID: 'Utdelningsbeloppet måste vara större än noll.',
  DIVIDEND_EXCEEDS_BOARD_PROPOSAL:
    'Stämman får inte besluta om större utdelning än styrelsen föreslagit (ABL 18 kap. 1 §) utan angivet skäl (bolagsordning eller minoritetskrav).',
  DIVIDEND_EXCEEDS_DISTRIBUTABLE:
    'Utdelningen överstiger fritt eget kapital enligt fastställd balansräkning efter senare värdeöverföringar (ABL 17 kap. 3 §).',
  DIVIDEND_PAYMENT_DATE_INVALID: 'Utbetalningsdagen kan inte ligga före beslutsdagen.',
  DIVIDEND_DRAFT_INVALID: 'Utdelningsverifikationen stämmer inte med beslutet.',
  DIVIDEND_PRIOR_RESULT_NOT_TRANSFERRED:
    'Föregående års resultat ligger kvar på 2099. Bokför omföringen till 2098 först.',
  DIVIDEND_DECISION_NOT_FOUND: 'Utdelningsbeslutet hittades inte.',
  DIVIDEND_OVERPAID: 'Utbetalningen överstiger återstående beslutad utdelning.',
  DIVIDEND_NO_OPEN_PERIOD: 'Det finns inget öppet räkenskapsår för datumet.',
}

export class DividendError extends Error {
  constructor(
    public readonly code: DividendErrorCode,
    public readonly details?: string,
  ) {
    super(DIVIDEND_ERROR_MESSAGES_SV[code])
    this.name = 'DividendError'
  }
}

/** Map an RPC error whose message is one of our codes to a DividendError. */
export function toDividendError(error: { message?: string; details?: string } | null | undefined): DividendError | null {
  const message = error?.message ?? ''
  const code = (Object.keys(DIVIDEND_ERROR_MESSAGES_SV) as DividendErrorCode[]).find((c) => message === c)
  return code ? new DividendError(code, error?.details) : null
}

/**
 * Lines for the stämma voucher. `balance2098` is credit-positive (a profit
 * carried to 2098 is > 0). 2098 is cleared; 2898 takes the dividend; the
 * difference is balanserat on 2091.
 */
export function planDividendDecisionLines(balance2098: number, dividend: number): CreateJournalEntryLineInput[] {
  const b = roundOre(balance2098)
  const d = roundOre(dividend)
  if (d <= 0) throw new DividendError('DIVIDEND_AMOUNT_INVALID')
  const lines: CreateJournalEntryLineInput[] = []
  if (b > 0) {
    lines.push({ account_number: DIVIDEND_ACCOUNTS.priorYearResult, debit_amount: b, credit_amount: 0, line_description: 'Föregående års resultat enligt stämmobeslut' })
  } else if (b < 0) {
    lines.push({ account_number: DIVIDEND_ACCOUNTS.priorYearResult, debit_amount: 0, credit_amount: -b, line_description: 'Föregående års förlust enligt stämmobeslut' })
  }
  lines.push({ account_number: DIVIDEND_ACCOUNTS.dividendPayable, debit_amount: 0, credit_amount: d, line_description: 'Beslutad utdelning' })
  const toRetained = roundOre(b - d)
  if (toRetained > 0) {
    lines.push({ account_number: DIVIDEND_ACCOUNTS.retainedEarnings, debit_amount: 0, credit_amount: toRetained, line_description: 'Balanseras i ny räkning' })
  } else if (toRetained < 0) {
    lines.push({ account_number: DIVIDEND_ACCOUNTS.retainedEarnings, debit_amount: -toRetained, credit_amount: 0, line_description: 'Utdelning ur balanserade vinstmedel' })
  }
  return lines
}

export interface PrudenceInput {
  /** Eget kapital (class 20) at the balance date. */
  equity: number
  /** Obeskattade reserver (class 21). */
  untaxedReserves: number
  /** Summa tillgångar. */
  totalAssets: number
  /** Likvida medel (19xx) now. */
  cash: number
  dividend: number
  /** Bolagsskatt used for the equity share of untaxed reserves (20,6 % from 2021). */
  corporateTaxRate?: number
}

export interface PrudenceAssessment {
  adjustedEquityBefore: number
  adjustedEquityAfter: number
  equityRatioBefore: number | null
  equityRatioAfter: number | null
  cashAfter: number
  warnings: string[]
}

/**
 * Key figures for the board's motivated statement (ABL 18 kap. 4 §). The law
 * sets no fixed ratio: the figures support the judgement, they do not replace
 * it. Justerat eget kapital counts the untaxed reserves net of deferred tax.
 */
export function assessDividendPrudence(input: PrudenceInput): PrudenceAssessment {
  const tax = input.corporateTaxRate ?? 0.206
  const adjustedBefore = roundOre(input.equity + input.untaxedReserves * (1 - tax))
  const adjustedAfter = roundOre(adjustedBefore - input.dividend)
  const assetsAfter = roundOre(input.totalAssets - input.dividend)
  const ratio = (eq: number, assets: number) => (assets > 0 ? Math.round((eq / assets) * 10000) / 10000 : null)
  const cashAfter = roundOre(input.cash - input.dividend)
  const warnings: string[] = []
  if (cashAfter < 0) {
    warnings.push('Likvida medel räcker inte till utdelningen. Utdelningen kan inte betalas utan ny finansiering.')
  }
  if (adjustedAfter <= 0) {
    warnings.push('Justerat eget kapital blir noll eller negativt efter utdelningen.')
  }
  return {
    adjustedEquityBefore: adjustedBefore,
    adjustedEquityAfter: adjustedAfter,
    equityRatioBefore: ratio(adjustedBefore, input.totalAssets),
    equityRatioAfter: ratio(adjustedAfter, assetsAfter),
    cashAfter,
    warnings,
  }
}

/**
 * KU31: which income year the dividend belongs to and when the kontrolluppgift
 * is due. A kupongbolag's dividend is available on the stämma day unless the
 * stämma set a later payment day.
 */
export function ku31Obligation(decisionDate: string, paymentDate: string | null): { incomeYear: number; dueDate: string } {
  const available = paymentDate && paymentDate > decisionDate ? paymentDate : decisionDate
  const incomeYear = Number(available.slice(0, 4))
  return { incomeYear, dueDate: `${incomeYear + 1}-01-31` }
}

async function cancelDraft(supabase: SupabaseClient, companyId: string, draftId: string) {
  const { error } = await supabase
    .from('journal_entries')
    .update({ status: 'cancelled' })
    .eq('id', draftId)
    .eq('company_id', companyId)
    .eq('status', 'draft')
  if (error) log.error('dividend draft cleanup failed (draft remains)', error, { draftId })
}

async function loadPosted(supabase: SupabaseClient, companyId: string, entryId: string): Promise<JournalEntry> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .single()
  if (error || !data) throw new Error(error?.message ?? 'Verifikationen kunde inte läsas.')
  return data as JournalEntry
}

export interface BookDividendDecisionInput {
  companyId: string
  userId: string
  dividendProposalId: string
  decisionDate: string
  amount: number
  paymentDate?: string | null
  deviationReason?: string | null
}

export interface BookedDividendDecision {
  dividendDecisionId: string
  entry: JournalEntry
  paymentDate: string
  limits: Record<string, unknown>
  ku31: { incomeYear: number; dueDate: string }
}

/**
 * Book the stämma's dividend decision. `supabase` must be a service-role
 * client (the RPCs are service-only); the caller authorizes the user first.
 */
export async function bookDividendDecision(
  supabase: SupabaseClient,
  input: BookDividendDecisionInput,
): Promise<BookedDividendDecision> {
  const periodId = await findFiscalPeriod(supabase, input.companyId, input.decisionDate)
  if (!periodId) throw new DividendError('DIVIDEND_NO_OPEN_PERIOD')

  // 2099 → 2098 must precede the disposition. The omföring is its own
  // idempotent voucher dated the first day of the year (BAS practice).
  await generateResultAppropriation(supabase, input.companyId, input.userId, periodId)

  const { data: balance, error: balanceError } = await supabase.rpc('__ledger_balance_at', {
    p_company_id: input.companyId,
    p_account_from: DIVIDEND_ACCOUNTS.priorYearResult,
    p_account_to: DIVIDEND_ACCOUNTS.priorYearResult,
    p_date: input.decisionDate,
  })
  if (balanceError) throw new Error(balanceError.message)

  const draft = await createDraftEntry(supabase, input.companyId, input.userId, {
    fiscal_period_id: periodId,
    entry_date: input.decisionDate,
    description: `Vinstdisposition och utdelning enligt årsstämmobeslut ${input.decisionDate}`,
    source_type: 'dividend_decision',
    source_id: input.dividendProposalId,
    lines: planDividendDecisionLines(Number(balance) || 0, input.amount),
  })

  const { data, error } = await supabase.rpc('book_dividend_decision', {
    p_company_id: input.companyId,
    p_dividend_proposal_id: input.dividendProposalId,
    p_decision_date: input.decisionDate,
    p_decided_amount: roundOre(input.amount),
    p_payment_date: input.paymentDate ?? null,
    p_deviation_reason: input.deviationReason ?? null,
    p_draft_entry_id: draft.id,
    p_user_id: input.userId,
  })
  if (error || !data) {
    await cancelDraft(supabase, input.companyId, draft.id)
    throw toDividendError(error) ?? new Error(error?.message ?? 'Utdelningsbeslutet kunde inte bokföras.')
  }

  const result = data as { dividend_decision_id: string; payment_date: string; limits: Record<string, unknown> }
  const entry = await loadPosted(supabase, input.companyId, draft.id)
  await eventBus.emit({ type: 'journal_entry.committed', payload: { entry, userId: input.userId, companyId: input.companyId } })
  return {
    dividendDecisionId: result.dividend_decision_id,
    entry,
    paymentDate: result.payment_date,
    limits: result.limits,
    ku31: ku31Obligation(input.decisionDate, result.payment_date),
  }
}

export interface BookDividendPaymentInput {
  companyId: string
  userId: string
  dividendDecisionId: string
  paymentDate: string
  amount: number
  cashAccount?: string
}

export async function bookDividendPayment(
  supabase: SupabaseClient,
  input: BookDividendPaymentInput,
): Promise<{ entry: JournalEntry; remaining: number }> {
  const cashAccount = input.cashAccount ?? DIVIDEND_ACCOUNTS.bank
  if (!/^19\d{2}$/.test(cashAccount)) throw new DividendError('DIVIDEND_DRAFT_INVALID')
  const amount = roundOre(input.amount)
  if (amount <= 0) throw new DividendError('DIVIDEND_AMOUNT_INVALID')
  const periodId = await findFiscalPeriod(supabase, input.companyId, input.paymentDate)
  if (!periodId) throw new DividendError('DIVIDEND_NO_OPEN_PERIOD')

  const draft = await createDraftEntry(supabase, input.companyId, input.userId, {
    fiscal_period_id: periodId,
    entry_date: input.paymentDate,
    description: 'Utbetalning av beslutad utdelning',
    source_type: 'dividend_payment',
    source_id: input.dividendDecisionId,
    lines: [
      { account_number: DIVIDEND_ACCOUNTS.dividendPayable, debit_amount: amount, credit_amount: 0, line_description: 'Utbetald utdelning' },
      { account_number: cashAccount, debit_amount: 0, credit_amount: amount, line_description: 'Utbetald utdelning' },
    ],
  })

  const { data, error } = await supabase.rpc('book_dividend_payment', {
    p_company_id: input.companyId,
    p_dividend_decision_id: input.dividendDecisionId,
    p_draft_entry_id: draft.id,
    p_user_id: input.userId,
  })
  if (error || !data) {
    await cancelDraft(supabase, input.companyId, draft.id)
    throw toDividendError(error) ?? new Error(error?.message ?? 'Utbetalningen kunde inte bokföras.')
  }
  const entry = await loadPosted(supabase, input.companyId, draft.id)
  await eventBus.emit({ type: 'journal_entry.committed', payload: { entry, userId: input.userId, companyId: input.companyId } })
  return { entry, remaining: roundOre(Number((data as { remaining: number }).remaining) || 0) }
}
