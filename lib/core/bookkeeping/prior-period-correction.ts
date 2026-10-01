import type { SupabaseClient } from '@supabase/supabase-js'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import type { AccountingFramework, CreateJournalEntryLineInput, EntityType, FiscalPeriod, JournalEntry } from '@/types'

/**
 * Rättelse av fel från ett stängt räkenskapsår.
 *
 * A closed year whose annual report is not yet adopted or filed is corrected
 * by reopening it (fiscal_period_reopen_requests). Once the report is adopted
 * or filed it is final, and the error is corrected in the current open year
 * with a new verifikation — never by editing the posted entries (BFL 5 kap.
 * 5 §; BFNAR 2013:2 rättelse genom ny verifikation):
 *
 *   current_year        K1, K2 and K3: the correction goes through the
 *                       current year's result (or between balance accounts).
 *                       Comparatives are not restated.
 *   equity_restatement  K3 kap. 10, aktiebolag only: a material error is
 *                       corrected retroactively against opening equity
 *                       (fritt eget kapital, 2090–2098), so only balance
 *                       sheet accounts may appear. The next annual report
 *                       restates comparatives and discloses the error.
 *
 * Neither method may book on årets resultat (2099/8999): those are produced
 * by the year-end closing, not by entries.
 */

export type PriorPeriodCorrectionMethod = 'current_year' | 'equity_restatement'

export type PriorPeriodCorrectionIssue =
  | 'equity_restatement_requires_k3_ab'
  | 'equity_restatement_balance_accounts_only'
  | 'equity_restatement_needs_equity_line'
  | 'retained_earnings_requires_equity_restatement'
  | 'closing_result_account'

const isRetainedEarnings = (account: string) => /^209[0-8]$/.test(account)
const isClosingResult = (account: string) => account === '2099' || account === '8999'
const isBalanceAccount = (account: string) => /^[12]\d{3}$/.test(account)

export function priorPeriodCorrectionIssues(input: {
  method: PriorPeriodCorrectionMethod
  framework: AccountingFramework
  entityType: EntityType
  accounts: string[]
}): PriorPeriodCorrectionIssue[] {
  const issues: PriorPeriodCorrectionIssue[] = []
  const { accounts } = input
  if (accounts.some(isClosingResult)) issues.push('closing_result_account')

  if (input.method === 'equity_restatement') {
    if (input.framework !== 'k3' || input.entityType !== 'aktiebolag') issues.push('equity_restatement_requires_k3_ab')
    if (!accounts.every(isBalanceAccount)) issues.push('equity_restatement_balance_accounts_only')
    if (!accounts.some(isRetainedEarnings)) issues.push('equity_restatement_needs_equity_line')
  } else if (input.entityType === 'aktiebolag' && accounts.some(isRetainedEarnings)) {
    // Booking a prior-year error straight against balanserat resultat is a
    // retroactive correction, which only K3 allows and only as a restatement.
    issues.push('retained_earnings_requires_equity_restatement')
  }
  return issues
}

export const PRIOR_CORRECTION_ISSUE_TEXT: Record<PriorPeriodCorrectionIssue, string> = {
  equity_restatement_requires_k3_ab:
    'Retroaktiv rättelse mot eget kapital är bara tillåten för aktiebolag som följer K3. Under K1 och K2 rättas felet i årets resultat.',
  equity_restatement_balance_accounts_only:
    'Vid rättelse mot eget kapital får bara balanskonton (klass 1–2) användas.',
  equity_restatement_needs_equity_line:
    'Rättelse mot eget kapital ska motbokas mot balanserat resultat (2091) eller annat konto för fritt eget kapital (2090–2098).',
  retained_earnings_requires_equity_restatement:
    'Balanserat resultat (2090–2098) används bara vid retroaktiv rättelse enligt K3. Bokför rättelsen mot rätt resultat- eller balanskonto i stället.',
  closing_result_account:
    'Årets resultat (2099/8999) bokas av bokslutet och får inte användas i en rättelse.',
}

export class PriorPeriodCorrectionError extends Error {
  constructor(
    public readonly code: 'PRIOR_CORRECTION_PERIOD_NOT_CLOSED' | 'PRIOR_CORRECTION_TARGET_INVALID' | 'PRIOR_CORRECTION_LINES_INVALID' | 'NOT_FOUND',
    public readonly issues: PriorPeriodCorrectionIssue[] = [],
  ) {
    super(code)
  }
}

export interface PriorPeriodCorrectionInput {
  method: PriorPeriodCorrectionMethod
  fiscal_period_id: string
  entry_date: string
  description: string
  reason: string
  original_reference?: string
  lines: CreateJournalEntryLineInput[]
}

const METHOD_TEXT: Record<PriorPeriodCorrectionMethod, string> = {
  current_year: 'rättat i årets resultat',
  equity_restatement: 'retroaktiv rättelse mot eget kapital (K3 kap. 10)',
}

/** Book the correction of an error in the closed year `erroneousPeriodId`. */
export async function bookPriorPeriodCorrection(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  erroneousPeriodId: string,
  input: PriorPeriodCorrectionInput,
): Promise<JournalEntry> {
  const [{ data: erroneous }, { data: target }, { data: company }] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed')
      .eq('id', erroneousPeriodId)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed, locked_at')
      .eq('id', input.fiscal_period_id)
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase.from('companies').select('entity_type, accounting_framework').eq('id', companyId).maybeSingle(),
  ])
  if (!erroneous || !company) throw new PriorPeriodCorrectionError('NOT_FOUND')
  const wrong = erroneous as Pick<FiscalPeriod, 'id' | 'name' | 'period_start' | 'period_end' | 'is_closed'>
  if (!wrong.is_closed) throw new PriorPeriodCorrectionError('PRIOR_CORRECTION_PERIOD_NOT_CLOSED')

  const open = target as Pick<FiscalPeriod, 'id' | 'period_start' | 'period_end' | 'is_closed' | 'locked_at'> | null
  if (
    !open ||
    open.is_closed ||
    open.locked_at ||
    open.period_start <= wrong.period_end ||
    input.entry_date < open.period_start ||
    input.entry_date > open.period_end
  ) {
    throw new PriorPeriodCorrectionError('PRIOR_CORRECTION_TARGET_INVALID')
  }

  const issues = priorPeriodCorrectionIssues({
    method: input.method,
    framework: (company.accounting_framework as AccountingFramework) ?? 'k2',
    entityType: company.entity_type as EntityType,
    accounts: input.lines.map((l) => l.account_number),
  })
  if (issues.length > 0) throw new PriorPeriodCorrectionError('PRIOR_CORRECTION_LINES_INVALID', issues)

  const notes = [
    `Rättelse av fel avseende räkenskapsår ${wrong.name} (${wrong.period_start} – ${wrong.period_end}), ${METHOD_TEXT[input.method]}.`,
    `Orsak: ${input.reason}`,
    input.original_reference ? `Avser: ${input.original_reference}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  return createJournalEntry(supabase, companyId, userId, {
    fiscal_period_id: open.id,
    entry_date: input.entry_date,
    description: `Rättelse ${wrong.name}: ${input.description}`,
    source_type: 'prior_period_correction',
    source_id: wrong.id,
    notes,
    lines: input.lines,
  })
}
