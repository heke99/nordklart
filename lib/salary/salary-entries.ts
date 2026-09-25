import { createDraftEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { eventBus } from '@/lib/events'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { createLogger } from '@/lib/logger'
import { SALARY_ACCOUNTS, getLineItemAccount } from './account-mapping'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  JournalEntry,
} from '@/types'
import { roundOre } from '@/lib/money'

const log = createLogger('salary-entries')

export interface SalaryRunEmployee {
  employee_id: string
  employment_type: string
  gross_salary: number
  tax_withheld: number
  net_salary: number
  avgifter_amount: number
  avgifter_rate: number
  vacation_accrual: number
  vacation_accrual_avgifter: number
  cost_center?: string
  project?: string
  line_items: Array<{
    item_type: string
    amount: number
    account_number: string | null
    is_net_deduction: boolean
    is_gross_deduction: boolean
  }>
  // Löneväxling pension (if applicable)
  pension_contribution?: number
  pension_slp?: number
}

interface SalaryRunData {
  id: string
  period_year: number
  period_month: number
  payment_date: string
  voucher_series: string
  total_gross: number
  total_tax: number
  total_net: number
  total_avgifter: number
  total_vacation_accrual: number
  employees: SalaryRunEmployee[]
}

/**
 * Book a salary run: create its verifikationer and post them together.
 *
 *   1. Salary entry: gross salary expenses, tax withholding, nettolöneavdrag,
 *      net payment
 *   2. Avgifter entry: employer contributions (skipped when 0, e.g. only
 *      F-skatt payees)
 *   3. Vacation entry: semesteravsättning + avgifter on it (if any)
 *   4. Pension entry: löneväxling pension + SLP (if any)
 *
 * All vouchers are created as drafts, then book_salary_run commits every one
 * of them and flips the run to 'booked' in ONE database transaction (voucher
 * numbers are assigned there). If anything fails the drafts are cancelled and
 * nothing is posted — a retry can never book the salary twice.
 */
export async function createSalaryRunEntries(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData
): Promise<{
  salaryEntry: JournalEntry
  avgifterEntry: JournalEntry | null
  vacationEntry: JournalEntry | null
  pensionEntry: JournalEntry | null
  bookedRun: Record<string, unknown>
}> {
  const entryDate = run.payment_date
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
  if (!fiscalPeriodId) {
    throw new Error(`Ingen öppen räkenskapsperiod för datum ${entryDate}`)
  }

  const periodLabel = `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
  const desc = `Lön ${periodLabel}`

  await ensureSalaryAccountsExist(supabase, companyId, userId, run)

  const salaryInput = buildSalaryInput(run, fiscalPeriodId, desc)

  const totalAvgifter = roundOre(run.employees.reduce((sum, e) => sum + e.avgifter_amount, 0))
  const avgifterInput = totalAvgifter > 0 ? buildAvgifterInput(run, fiscalPeriodId, desc) : null

  const totalVacation = run.employees.reduce((sum, e) => sum + e.vacation_accrual, 0)
  const totalVacationAvgifter = run.employees.reduce((sum, e) => sum + e.vacation_accrual_avgifter, 0)
  const vacationInput = roundOre(totalVacation) > 0 || roundOre(totalVacationAvgifter) > 0
    ? buildVacationInput(run, fiscalPeriodId, desc, totalVacation, totalVacationAvgifter)
    : null

  // Per deductions-lonevaxling.md: pension = löneväxling × 1.058, SLP = pension × 24.26%
  const totalPension = run.employees.reduce((sum, e) => sum + (e.pension_contribution || 0), 0)
  const totalSlp = run.employees.reduce((sum, e) => sum + (e.pension_slp || 0), 0)
  const pensionInput = roundOre(totalPension) > 0
    ? buildPensionInput(run, fiscalPeriodId, desc, totalPension, totalSlp)
    : null

  const drafts: JournalEntry[] = []
  const cancelDrafts = async () => {
    if (drafts.length === 0) return
    const { error } = await supabase
      .from('journal_entries')
      .update({ status: 'cancelled' })
      .in('id', drafts.map((d) => d.id))
      .eq('company_id', companyId)
      .eq('status', 'draft')
    if (error) log.error('salary draft cleanup failed (drafts remain)', error, { salaryRunId: run.id })
  }

  let draftIds: { salary: string; avgifter: string | null; vacation: string | null; pension: string | null }
  try {
    const create = async (input: CreateJournalEntryInput | null) => {
      if (!input) return null
      const draft = await createDraftEntry(supabase, companyId, userId, input)
      drafts.push(draft)
      return draft.id
    }
    draftIds = {
      salary: (await create(salaryInput))!,
      avgifter: await create(avgifterInput),
      vacation: await create(vacationInput),
      pension: await create(pensionInput),
    }
  } catch (err) {
    await cancelDrafts()
    throw err
  }

  const actor = getActor()
  const { data: bookedRun, error: bookError } = await supabase.rpc('book_salary_run', {
    p_company_id: companyId,
    p_run_id: run.id,
    p_salary_entry_id: draftIds.salary,
    p_avgifter_entry_id: draftIds.avgifter,
    p_vacation_entry_id: draftIds.vacation,
    p_pension_entry_id: draftIds.pension,
    p_booked_by: userId,
    p_actor_type: actor?.type ?? null,
    p_actor_label: actor?.label ?? null,
  })
  if (bookError || !bookedRun) {
    await cancelDrafts()
    log.error('book_salary_run failed', bookError ?? undefined, { salaryRunId: run.id })
    throw new BookkeepingDatabaseError('commit_entry', bookError?.message ?? 'no result')
  }

  const { data: posted, error: postedError } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .in('id', drafts.map((d) => d.id))
    .eq('company_id', companyId)
  if (postedError) throw new BookkeepingDatabaseError('commit_entry', postedError.message)
  const byId = new Map((posted ?? []).map((e) => [e.id as string, e as JournalEntry]))
  for (const entry of byId.values()) {
    await eventBus.emit({ type: 'journal_entry.committed', payload: { entry, userId, companyId } })
  }

  return {
    salaryEntry: byId.get(draftIds.salary)!,
    avgifterEntry: draftIds.avgifter ? byId.get(draftIds.avgifter) ?? null : null,
    vacationEntry: draftIds.vacation ? byId.get(draftIds.vacation) ?? null : null,
    pensionEntry: draftIds.pension ? byId.get(draftIds.pension) ?? null : null,
    bookedRun: bookedRun as Record<string, unknown>,
  }
}

/**
 * Entry 1: Salary booking.
 *
 * Debit:  7210/7220/7240 Löner (per employee by type)
 * Credit: 2710 Personalskatt (total tax withheld)
 * Credit: 1930 Företagskonto (total net salary)
 */
function buildSalaryInput(
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string
): CreateJournalEntryInput {
  const lines: CreateJournalEntryLineInput[] = []

  // Aggregate salary expenses by account
  const expenseByAccount = new Map<string, number>()
  const netDeductionByAccount = new Map<string, number>()
  for (const emp of run.employees) {
    // Base salary and additions go to the employee-type account
    const salaryAccount = getEmployeeSalaryAccount(emp.employment_type)

    // Add salary line items that are cash expenses
    // Förmånsvärden (benefits) are excluded — they affect the tax base but
    // have no cash flow and should not appear as expense lines in the journal.
    const BENEFIT_TYPES = ['benefit_car', 'benefit_housing', 'benefit_meals', 'benefit_wellness', 'benefit_bike', 'benefit_other']
    // Skattefria traktamenten/bilersättningar are paid with the net salary
    // but are not bruttolön: debit their own accounts (7321/7331) outside the
    // gross reconciliation below.
    const TAX_FREE_TYPES = ['traktamente_taxfree', 'mileage_taxfree']
    let lineItemTotal = 0
    for (const li of emp.line_items) {
      if (li.is_gross_deduction) continue
      if (BENEFIT_TYPES.includes(li.item_type)) continue // No cash flow for förmånsvärden
      if (li.is_net_deduction) {
        const account = resolveLineAccount(li, emp.employment_type)
        // Withheld from the employee's pay and owed elsewhere: credit the
        // liability/receivable (2790 / 1610 / 7388). Stored amounts may be
        // signed either way; the deduction is its absolute value.
        const current = netDeductionByAccount.get(account) || 0
        netDeductionByAccount.set(account, current + Math.abs(li.amount))
        continue
      }
      const account = resolveLineAccount(li, emp.employment_type)
      const current = expenseByAccount.get(account) || 0
      expenseByAccount.set(account, current + li.amount)
      if (!TAX_FREE_TYPES.includes(li.item_type)) lineItemTotal += li.amount
    }

    // Ensure the debit side always equals gross_salary (minus gross deductions,
    // which the credit side doesn't book either). If line items don't cover the
    // full gross amount, book the remainder to the default salary account so the
    // entry balances. Without this, an employee with overtime line items but no
    // base-salary line item would fail the check_journal_entry_balance() trigger.
    const baseRemainder = roundOre((emp.gross_salary - lineItemTotal))
    if (baseRemainder !== 0) {
      const current = expenseByAccount.get(salaryAccount) || 0
      expenseByAccount.set(salaryAccount, current + baseRemainder)
    }
  }

  // Debit: Salary expense accounts
  for (const [account, amount] of expenseByAccount) {
    if (amount === 0) continue
    if (amount > 0) {
      lines.push({
        account_number: account,
        debit_amount: roundOre(amount),
        credit_amount: 0,
        line_description: `${desc} — ${accountLabel(account)}`,
      })
    } else {
      // Negative amounts (deductions) become credits
      lines.push({
        account_number: account,
        debit_amount: 0,
        credit_amount: roundOre(Math.abs(amount)),
        line_description: `${desc} — ${accountLabel(account)}`,
      })
    }
  }

  // Credit: Tax withholding
  const totalTax = run.employees.reduce((sum, e) => sum + e.tax_withheld, 0)
  if (totalTax > 0) {
    lines.push({
      account_number: SALARY_ACCOUNTS.TAX_WITHHELD,
      debit_amount: 0,
      credit_amount: roundOre(totalTax),
      line_description: `${desc} — Personalskatt`,
    })
  }

  // Credit: Nettolöneavdrag to the accounts they are owed to.
  for (const [account, amount] of netDeductionByAccount) {
    if (roundOre(amount) === 0) continue
    lines.push({
      account_number: account,
      debit_amount: 0,
      credit_amount: roundOre(amount),
      line_description: `${desc} — Nettolöneavdrag`,
    })
  }

  // Credit: Net salary to bank
  const totalNet = run.employees.reduce((sum, e) => sum + e.net_salary, 0)
  if (totalNet > 0) {
    lines.push({
      account_number: SALARY_ACCOUNTS.BANK,
      debit_amount: 0,
      credit_amount: roundOre(totalNet),
      line_description: `${desc} — Nettolön`,
    })
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: desc,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  return input
}

/**
 * Entry 2: Arbetsgivaravgifter.
 *
 * Debit:  7510 Lagstadgade sociala avgifter
 * Credit: 2731 Avräkning sociala avgifter
 */
function buildAvgifterInput(
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string
): CreateJournalEntryInput {
  const totalAvgifter = run.employees.reduce((sum, e) => sum + e.avgifter_amount, 0)
  const roundedAvgifter = roundOre(totalAvgifter)

  const lines: CreateJournalEntryLineInput[] = [
    {
      account_number: SALARY_ACCOUNTS.AVGIFTER_EXPENSE,
      debit_amount: roundedAvgifter,
      credit_amount: 0,
      line_description: `${desc} — Arbetsgivaravgifter`,
    },
    {
      account_number: SALARY_ACCOUNTS.AVGIFTER_LIABILITY,
      debit_amount: 0,
      credit_amount: roundedAvgifter,
      line_description: `${desc} — Arbetsgivaravgifter`,
    },
  ]

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: `${desc} — Arbetsgivaravgifter`,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  return input
}

/**
 * Entry 3: Vacation accrual.
 *
 * Debit:  7290 Förändring semesterlöneskuld
 * Credit: 2920 Upplupna semesterlöner
 * Debit:  7519 Sociala avgifter semester
 * Credit: 2940 Upplupna sociala avgifter
 */
function buildVacationInput(
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string,
  totalVacation: number,
  totalVacationAvgifter: number
): CreateJournalEntryInput {
  const roundedVacation = roundOre(totalVacation)
  const roundedAvgifter = roundOre(totalVacationAvgifter)

  const lines: CreateJournalEntryLineInput[] = []

  if (roundedVacation > 0) {
    lines.push(
      {
        account_number: SALARY_ACCOUNTS.VACATION_ACCRUAL_EXPENSE,
        debit_amount: roundedVacation,
        credit_amount: 0,
        line_description: `${desc} — Semesteravsättning`,
      },
      {
        account_number: SALARY_ACCOUNTS.VACATION_ACCRUAL_LIABILITY,
        debit_amount: 0,
        credit_amount: roundedVacation,
        line_description: `${desc} — Semesteravsättning`,
      }
    )
  }

  if (roundedAvgifter > 0) {
    lines.push(
      {
        account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_EXPENSE,
        debit_amount: roundedAvgifter,
        credit_amount: 0,
        line_description: `${desc} — Sociala avgifter på semester`,
      },
      {
        account_number: SALARY_ACCOUNTS.VACATION_AVGIFTER_LIABILITY,
        debit_amount: 0,
        credit_amount: roundedAvgifter,
        line_description: `${desc} — Sociala avgifter på semester`,
      }
    )
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: `${desc} — Semesteravsättning`,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  return input
}

/**
 * Entry 4: Pension provisions + SLP (löneväxling).
 *
 * Debit:  7410 Pensionsförsäkringspremier
 * Credit: 2740 Skuld pensionsförsäkringar
 * Debit:  7533 Särskild löneskatt på pensionskostnader (24.26%)
 * Credit: 2514 Beräknad särskild löneskatt
 *
 * Per deductions-lonevaxling.md: pension = löneväxling × 1.058
 */
function buildPensionInput(
  run: SalaryRunData,
  fiscalPeriodId: string,
  desc: string,
  totalPension: number,
  totalSlp: number
): CreateJournalEntryInput {
  const roundedPension = roundOre(totalPension)
  const roundedSlp = roundOre(totalSlp)

  const lines: CreateJournalEntryLineInput[] = [
    {
      account_number: SALARY_ACCOUNTS.PENSION_EXPENSE,
      debit_amount: roundedPension,
      credit_amount: 0,
      line_description: `${desc} — Pensionsförsäkringspremier`,
    },
    {
      account_number: SALARY_ACCOUNTS.PENSION_LIABILITY,
      debit_amount: 0,
      credit_amount: roundedPension,
      line_description: `${desc} — Pensionsförsäkringspremier`,
    },
  ]

  if (roundedSlp > 0) {
    lines.push(
      {
        account_number: SALARY_ACCOUNTS.SLP_EXPENSE,
        debit_amount: roundedSlp,
        credit_amount: 0,
        line_description: `${desc} — Särskild löneskatt 24,26%`,
      },
      {
        account_number: SALARY_ACCOUNTS.SLP_LIABILITY,
        debit_amount: 0,
        credit_amount: roundedSlp,
        line_description: `${desc} — Särskild löneskatt 24,26%`,
      }
    )
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: run.payment_date,
    description: `${desc} — Pensionsavsättning`,
    source_type: 'salary_payment',
    source_id: run.id,
    voucher_series: run.voucher_series,
    lines,
  }

  return input
}

// ============================================================
// Helpers
// ============================================================

function getEmployeeSalaryAccount(employmentType: string): string {
  switch (employmentType) {
    case 'company_owner': return SALARY_ACCOUNTS.SALARY_OWNER
    case 'board_member': return SALARY_ACCOUNTS.SALARY_BOARD
    default: return SALARY_ACCOUNTS.SALARY_EMPLOYEE
  }
}

/**
 * Ensure every BAS account referenced by the salary run exists in
 * chart_of_accounts. Users who seeded the minimal chart via
 * seed_chart_of_accounts will be missing many 7xxx/29xx accounts — we
 * auto-create them from BAS reference data on first salary booking.
 */
async function ensureSalaryAccountsExist(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  run: SalaryRunData
): Promise<void> {
  const needed = new Set<string>()

  for (const account of Object.values(SALARY_ACCOUNTS)) needed.add(account)

  for (const emp of run.employees) {
    needed.add(getEmployeeSalaryAccount(emp.employment_type))
    for (const li of emp.line_items) {
      const account = resolveLineAccount(li, emp.employment_type)
      if (account) needed.add(account)
    }
  }

  if (needed.size === 0) return

  const { data: existing, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .in('account_number', [...needed])

  if (error) {
    throw new Error(`Kunde inte läsa kontoplanen: ${error.message}`)
  }

  const existingSet = new Set((existing || []).map(a => a.account_number))
  const missing = [...needed].filter(num => !existingSet.has(num))
  if (missing.length === 0) return

  const inserts = missing.map(accountNumber => {
    const basRef = getBASReference(accountNumber)
    if (basRef) {
      return {
        user_id: userId,
        company_id: companyId,
        account_number: accountNumber,
        account_name: basRef.account_name,
        account_class: basRef.account_class,
        account_group: basRef.account_group,
        account_type: basRef.account_type,
        normal_balance: basRef.normal_balance,
        sru_code: basRef.sru_code,
        k2_excluded: basRef.k2_excluded,
        plan_type: 'full_bas',
        is_active: true,
        is_system_account: false,
      }
    }
    // Fallback — shouldn't happen for salary accounts, but keeps us safe.
    const classNum = parseInt(accountNumber.charAt(0), 10)
    const group = accountNumber.substring(0, 2)
    return {
      user_id: userId,
      company_id: companyId,
      account_number: accountNumber,
      account_name: `Konto ${accountNumber}`,
      account_class: classNum,
      account_group: group,
      account_type: classNum >= 4 ? 'expense' : classNum === 2 ? 'liability' : 'asset',
      normal_balance: classNum <= 1 || classNum >= 4 ? 'debit' : 'credit',
      plan_type: 'full_bas',
      is_active: true,
      is_system_account: false,
    }
  })

  const { error: insertError } = await supabase.from('chart_of_accounts').insert(inserts)
  if (insertError && !insertError.message.includes('duplicate')) {
    throw new Error(`Kunde inte skapa saknade konton: ${insertError.message}`)
  }

  log.info(`Auto-created ${missing.length} missing salary accounts: ${missing.join(', ')}`)
}

/**
 * The BAS account a salary line books to: the line's own account_number, or
 * the default mapping. Nettolöneavdrag saved before 2026-09-25 carry the old
 * default (7210/7385) — a cost account that must not be credited for money
 * owed to a union or repaid by the employee — so for those the mapping wins
 * unless a different account was chosen deliberately.
 */
export function resolveLineAccount(
  li: { item_type: string; account_number: string | null; is_net_deduction?: boolean },
  employmentType: string,
): string {
  const mapped = getLineItemAccount(li.item_type as never, employmentType)
  if (!li.account_number) return mapped
  if (li.is_net_deduction && (li.account_number === '7210' || li.account_number === '7385')) return mapped
  return li.account_number
}

function accountLabel(account: string): string {
  const labels: Record<string, string> = {
    '7210': 'Löner tjänstemän',
    '7220': 'Löner företagsledare',
    '7240': 'Styrelsearvoden',
    '7281': 'Sjuklöner',
    '7285': 'Semesterlöner',
    '7321': 'Traktamenten skattefria',
    '7322': 'Traktamenten skattepliktiga',
    '7331': 'Bilersättningar skattefria',
    '7332': 'Bilersättningar skattepliktiga',
    '1610': 'Förskott till anställda',
    '2790': 'Övriga löneavdrag',
    '7388': 'Anställdas ersättning för förmåner',
  }
  return labels[account] || `Konto ${account}`
}
