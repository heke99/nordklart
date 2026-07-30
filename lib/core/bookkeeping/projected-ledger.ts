import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryLineInput, TrialBalanceRow } from '@/types'
import { roundOre } from '@/lib/money'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import {
  listStagedYearEndAdjustments,
  type StagedYearEndAdjustment,
  type YearEndAdjustmentGroup,
} from './year-end-staging'

export interface ProjectedLedger {
  rows: TrialBalanceRow[]
  stagedAdjustments: StagedYearEndAdjustment[]
  applyLines(lines: readonly CreateJournalEntryLineInput[]): void
  resultBeforeTax(): number
  creditBalance(accountNumber: string): number
  debitBalance(accountNumber: string): number
  debitMovementInRange(accountFrom: string, accountTo: string): number
}

export async function buildProjectedLedger(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options: { excludeGroups?: YearEndAdjustmentGroup[] } = {},
): Promise<ProjectedLedger> {
  const [trialBalance, staged] = await Promise.all([
    generateTrialBalance(supabase, companyId, fiscalPeriodId, {
      excludeYearEndClosing: true,
    }),
    listStagedYearEndAdjustments(supabase, companyId, fiscalPeriodId),
  ])

  const excluded = new Set(options.excludeGroups ?? [])
  const included = staged.filter(
    (adjustment) => !excluded.has(adjustment.adjustment_group),
  )
  const rows = trialBalance.rows.map((row) => ({ ...row }))
  const rowByAccount = new Map(rows.map((row) => [row.account_number, row]))

  const applyLines = (lines: readonly CreateJournalEntryLineInput[]) => {
    for (const line of lines) {
      let row = rowByAccount.get(line.account_number)
      if (!row) {
        row = {
          account_number: line.account_number,
          account_name: `Konto ${line.account_number}`,
          account_class: Number(line.account_number.slice(0, 1)) || 0,
          opening_debit: 0,
          opening_credit: 0,
          period_debit: 0,
          period_credit: 0,
          closing_debit: 0,
          closing_credit: 0,
        }
        rows.push(row)
        rowByAccount.set(line.account_number, row)
      }
      const debit = Number(line.debit_amount) || 0
      const credit = Number(line.credit_amount) || 0
      row.period_debit = roundOre(row.period_debit + debit)
      row.period_credit = roundOre(row.period_credit + credit)
      row.closing_debit = roundOre(row.closing_debit + debit)
      row.closing_credit = roundOre(row.closing_credit + credit)
    }
  }

  for (const adjustment of included) {
    applyLines(adjustment.journal_lines)
  }
  rows.sort((a, b) => a.account_number.localeCompare(b.account_number))

  return {
    rows,
    stagedAdjustments: included,
    applyLines,
    resultBeforeTax: () => roundOre(rows.reduce((sum, row) => {
      if (row.account_class < 3 || row.account_class > 8) return sum
      if (row.account_number === '8999') return sum
      return sum + row.closing_credit - row.closing_debit
    }, 0)),
    creditBalance: (accountNumber) => {
      const row = rowByAccount.get(accountNumber)
      return roundOre((row?.closing_credit ?? 0) - (row?.closing_debit ?? 0))
    },
    debitBalance: (accountNumber) => {
      const row = rowByAccount.get(accountNumber)
      return roundOre((row?.closing_debit ?? 0) - (row?.closing_credit ?? 0))
    },
    debitMovementInRange: (accountFrom, accountTo) => roundOre(rows.reduce(
      (sum, row) => row.account_number >= accountFrom && row.account_number <= accountTo
        ? sum + row.period_debit - row.period_credit
        : sum,
      0,
    )),
  }
}
