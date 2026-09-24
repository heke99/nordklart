import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { FiscalPeriod } from '@/types'
import { fetchPeriodAccountNets } from '@/lib/reports/period-account-nets'
import type {
  INK2Declaration,
  INK2RRutor,
  INK2Rutor,
  INK2SRutor,
  INK2AccountMapping,
  INK2RSRUCode,
} from './types'
import {
  INK2R_ASSET_CODES,
  INK2R_EQUITY_LIABILITY_CODES,
  INK2S_ADDITION_CODES,
  INK2S_ADJUSTABLE_CODES,
  INK2S_DEDUCTION_CODES,
  INK2S_NUMERIC_CODES,
} from './types'
import {
  approvedAdjustmentAmount,
  listTaxDeclarationAdjustments,
  pendingAdjustmentWarnings,
} from '@/lib/tax-declaration/adjustments'
import { buildDeclarationReadiness, issue } from '@/lib/tax-declaration/readiness'

/**
 * INK2 Declaration Engine
 *
 * Generates INK2 (huvudblankett), INK2R (räkenskapsschema), and INK2S
 * (skattemässiga justeringar) for aktiebolag tax reporting.
 *
 * Account mappings follow the official BAS-to-SRU mapping from
 * bas.se/kontoplaner/sru/ and Skatteverket field code spec.
 *
 * INK2R contains the full balance sheet + income statement.
 * INK2S derives the result (4.1/4.2), the booked tax (4.3a), a default for
 * non-deductible costs (4.3c) and schablonintäkt på periodiseringsfonder
 * (4.6a); every other field comes from approved tax_declaration_adjustments.
 * Field codes follow Skatteverket's 2025P4 tables (lib/reports/sru).
 */

export { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from './account-mappings'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from './account-mappings'

/**
 * Truncate to nearest krona (drop öre) per SFL 22 kap. 1 §
 */
function truncateToKrona(value: number): number {
  return value >= 0 ? Math.floor(value) : Math.ceil(value)
}

function sumAccountRange(accountBalances: Map<string, number>, start: string, end: string): number {
  let total = 0
  for (const [account, balance] of accountBalances) {
    if (account >= start && account <= end) total += balance
  }
  return truncateToKrona(Math.abs(total))
}

function sumInk2SFields(ink2s: INK2SRutor, codes: readonly (keyof INK2SRutor)[]): number {
  return codes.reduce((sum, code) => {
    const value = ink2s[code]
    return typeof value === 'number' ? sum + value : sum
  }, 0)
}

/**
 * BAS accounts that are non-deductible by definition (the account name says
 * so), plus 8423 kostnadsränta for skatter och avgifter (IL 9 kap. 8 §).
 * Their debit balance is the default for INK2S 4.3c when no manual
 * adjustment has been recorded.
 */
export const NON_DEDUCTIBLE_COST_ACCOUNTS = [
  '5982', '6072', '6342', '6392', '6982', '6992', '7622', '7623', '7632', '8423',
] as const

export function sumNonDeductibleCosts(accountBalances: Map<string, number>): number {
  let total = 0
  for (const account of NON_DEDUCTIBLE_COST_ACCOUNTS) {
    total += accountBalances.get(account) ?? 0
  }
  return total > 0 ? truncateToKrona(total) : 0
}

/**
 * Schablonintäkt på periodiseringsfonder (IL 30 kap. 6 a §, INK2S 4.6a):
 * the funds at the START of the tax year times statslåneräntan at the end of
 * November the year before the tax year ends (floor 0,5 %). The rate lives in
 * year_end_rulesets keyed on the year the fiscal year ends.
 */
export async function estimatePeriodiseringsfondSchablon(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  periodStart: string,
  periodEnd: string,
): Promise<{ amount: number; openingFunds: number; rate: number | null }> {
  const lines = await fetchAllRows<{
    debit_amount: number | string | null
    credit_amount: number | string | null
  }>(({ from, to }) =>
    supabase
      .from('journal_entry_lines')
      .select('debit_amount, credit_amount, journal_entries!inner(company_id, fiscal_period_id, status, source_type)')
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', fiscalPeriodId)
      .eq('journal_entries.source_type', 'opening_balance')
      .in('journal_entries.status', ['posted', 'reversed'])
      .gte('account_number', '2110')
      .lte('account_number', '2139')
      .order('id', { ascending: true })
      .range(from, to),
  )

  let openingFunds = lines.reduce(
    (sum, l) => sum + (Number(l.credit_amount) || 0) - (Number(l.debit_amount) || 0),
    0,
  )

  // No opening-balance voucher in this period (first year in Nordklart with
  // history in earlier periods): take the ledger balance before the start.
  if (lines.length === 0) {
    const prior = await fetchAllRows<{
      debit_amount: number | string | null
      credit_amount: number | string | null
    }>(({ from, to }) =>
      supabase
        .from('journal_entry_lines')
        .select('debit_amount, credit_amount, journal_entries!inner(company_id, status, entry_date)')
        .eq('journal_entries.company_id', companyId)
        .in('journal_entries.status', ['posted', 'reversed'])
        .lt('journal_entries.entry_date', periodStart)
        .gte('account_number', '2110')
        .lte('account_number', '2139')
        .order('id', { ascending: true })
        .range(from, to),
    )
    openingFunds = prior.reduce(
      (sum, l) => sum + (Number(l.credit_amount) || 0) - (Number(l.debit_amount) || 0),
      0,
    )
  }

  if (openingFunds <= 0) return { amount: 0, openingFunds: 0, rate: null }

  const { data: ruleset } = await supabase
    .from('year_end_rulesets')
    .select('schablonintakt_rate')
    .eq('tax_year', Number(periodEnd.slice(0, 4)))
    .maybeSingle()
  const rate = ruleset ? Number(ruleset.schablonintakt_rate) : null
  if (rate === null || !Number.isFinite(rate)) return { amount: 0, openingFunds, rate: null }

  return { amount: truncateToKrona(openingFunds * rate), openingFunds, rate }
}

function createEmptyINK2SRutor(fyStart: string, fyEnd: string): INK2SRutor {
  const ink2s = { '7011': fyStart, '7012': fyEnd } as INK2SRutor
  for (const code of INK2S_NUMERIC_CODES) {
    ink2s[code] = 0
  }
  return ink2s
}

/**
 * Check if the balance sheet totals differ beyond the expected rounding tolerance.
 */
export function checkBalanceWarning(totalAssets: number, totalEquityLiabilities: number): string | null {
  const balanceDiff = Math.abs(totalAssets - totalEquityLiabilities)
  const ROUNDING_TOLERANCE_KR = 2
  if (balanceDiff > ROUNDING_TOLERANCE_KR && (totalAssets > 0 || totalEquityLiabilities > 0)) {
    return `Balansräkningen är inte i balans. Tillgångar: ${totalAssets} kr, Eget kapital och skulder: ${totalEquityLiabilities} kr (differens: ${balanceDiff} kr).`
  }
  return null
}

/** Create zero-initialized INK2R rutor */
function createEmptyINK2RRutor(): INK2RRutor {
  return {
    '7201': 0, '7202': 0, '7214': 0, '7215': 0, '7216': 0, '7217': 0,
    '7230': 0, '7231': 0, '7233': 0, '7232': 0, '7234': 0, '7235': 0,
    '7241': 0, '7242': 0, '7243': 0, '7244': 0, '7245': 0, '7246': 0,
    '7251': 0, '7252': 0, '7261': 0, '7262': 0, '7263': 0,
    '7270': 0, '7271': 0, '7281': 0,
    '7301': 0, '7302': 0,
    '7321': 0, '7322': 0, '7323': 0,
    '7331': 0, '7332': 0, '7333': 0,
    '7350': 0, '7351': 0, '7352': 0, '7353': 0, '7354': 0,
    '7360': 0, '7361': 0, '7362': 0, '7363': 0, '7364': 0,
    '7365': 0, '7366': 0, '7367': 0, '7369': 0, '7368': 0, '7370': 0,
    '7410': 0, '7411': 0, '7510': 0, '7412': 0, '7413': 0,
    '7511': 0, '7512': 0, '7513': 0, '7514': 0, '7515': 0, '7516': 0, '7517': 0,
    '7414': 0, '7518': 0, '7415': 0, '7519': 0, '7423': 0, '7530': 0,
    '7416': 0, '7520': 0, '7417': 0,
    '7521': 0, '7522': 0,
    '7524': 0, '7419': 0, '7420': 0, '7525': 0, '7421': 0, '7526': 0, '7422': 0, '7527': 0,
    '7528': 0,
    '7450': 0, '7550': 0,
  }
}

// Reuse canonical code arrays from types.ts (single source of truth)
const ASSET_CODES = INK2R_ASSET_CODES
const EQUITY_LIABILITY_CODES = INK2R_EQUITY_LIABILITY_CODES

/**
 * Generate INK2 declaration for a fiscal period
 */
export async function generateINK2Declaration(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string
): Promise<INK2Declaration> {

  // Fetch fiscal period
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    throw new Error('Fiscal period not found')
  }

  // Fetch company settings
  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name, org_number, entity_type, address_line1, postal_code, city, email')
    .eq('company_id', companyId)
    .single()

  // Resolve entity_type: prefer company_settings, fall back to companies table (NOT NULL, always reliable)
  let entityType = settings?.entity_type
  if (!entityType) {
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .single()
    if (companyError) throw new Error(`Failed to resolve entity type: ${companyError.message}`)
    entityType = company?.entity_type
  }

  if (entityType !== 'aktiebolag') {
    throw new Error('INK2 declaration is only for aktiebolag (limited company)')
  }

  // Net per account for the period, EXCLUDING the year-end closing vouchers.
  // After the close every class 3–8 account nets to zero inside the period;
  // counting the closing voucher made INK2R's income statement, the result
  // and the taxable surplus all come out as 0 exactly when the declaration is
  // allowed to be exported. The result is instead derived from the accounts
  // and added to fritt eget kapital below, so open and closed years agree.
  const accountBalances = await fetchPeriodAccountNets(supabase, companyId, fiscalPeriodId, {
    excludeYearEndClosing: true,
  })

  // Fetch chart of accounts for account names
  const accounts = await fetchAllRows<{ account_number: string; account_name: string }>(({ from, to }) =>
    supabase
      .from('chart_of_accounts')
      .select('account_number, account_name')
      .eq('company_id', companyId)
      .order('account_number', { ascending: true })
      .range(from, to)
  )

  const accountNameMap = new Map<string, string>()
  for (const acc of accounts) {
    accountNameMap.set(acc.account_number, acc.account_name)
  }

  // Initialize INK2R rutor and breakdown
  const ink2r = createEmptyINK2RRutor()
  const allCodes = Object.keys(ink2r) as INK2RSRUCode[]
  const breakdown = {} as INK2Declaration['breakdown']
  for (const code of allCodes) {
    breakdown[code] = { accounts: [], total: 0 }
  }

  const warnings: string[] = []

  // Sign-split groups ("Om netto +/−") are decided on the group's net, so they
  // are collected first and placed after the loop.
  const signSplitGroups = new Map<INK2AccountMapping, Array<{ accountNumber: string; income: number }>>()

  for (const [accountNumber, balance] of accountBalances) {
    if (Math.abs(balance) < 0.01) continue

    // 899x — årets resultat is calculated, never read from the ledger.
    if (accountNumber >= '8990' && accountNumber <= '8999') continue

    const mapping = INK2R_ACCOUNT_MAPPINGS.find((m) => isAccountInMapping(accountNumber, m))
    if (!mapping) {
      if (accountNumber.charAt(0) >= '1' && accountNumber.charAt(0) <= '8') {
        warnings.push(`Konto ${accountNumber} (${accountNameMap.get(accountNumber) || 'okänt'}) kunde inte mappas till ett SRU-fält.`)
      }
      continue
    }

    if (mapping.negativeSruCode) {
      const group = signSplitGroups.get(mapping) ?? []
      group.push({ accountNumber, income: -balance })
      signSplitGroups.set(mapping, group)
      continue
    }

    // Skatteverket convention: amounts are reported as positive values;
    // revenue and credit-normal balance-sheet items are negated.
    const amount = mapping.normalBalance === 'debit' ? balance : -balance
    ink2r[mapping.sruCode] += amount
    breakdown[mapping.sruCode].accounts.push({
      accountNumber,
      accountName: accountNameMap.get(accountNumber) || `Konto ${accountNumber}`,
      amount: truncateToKrona(amount),
    })
  }

  for (const [mapping, members] of signSplitGroups) {
    const net = members.reduce((sum, m) => sum + m.income, 0)
    const code = net >= 0 ? mapping.sruCode : mapping.negativeSruCode!
    const sign = net >= 0 ? 1 : -1
    ink2r[code] += sign * net
    for (const member of members) {
      breakdown[code].accounts.push({
        accountNumber: member.accountNumber,
        accountName: accountNameMap.get(member.accountNumber) || `Konto ${member.accountNumber}`,
        amount: truncateToKrona(sign * member.income),
      })
    }
  }

  // Truncate all INK2R rutor to whole kronor
  for (const code of allCodes) {
    ink2r[code] = truncateToKrona(ink2r[code])
    breakdown[code].total = ink2r[code]
  }

  if (ink2r['7511'] !== 0 && ink2r['7512'] !== 0) {
    warnings.push('Både råvaror (7511) och handelsvaror (7512) har belopp. Kontrollera att inköpskontona är fördelade rätt för verksamheten.')
  }

  // Operating result per INK2R 3.1–3.11 (costs are positive on the form).
  const operatingResult =
    ink2r['7410'] + ink2r['7411'] - ink2r['7510'] + ink2r['7412'] + ink2r['7413']
    - ink2r['7511'] - ink2r['7512'] - ink2r['7513'] - ink2r['7514']
    - ink2r['7515'] - ink2r['7516'] - ink2r['7517']

  // Financial items 3.12–3.18.
  const financialItems =
    ink2r['7414'] - ink2r['7518'] + ink2r['7415'] - ink2r['7519']
    + ink2r['7423'] - ink2r['7530'] + ink2r['7416'] - ink2r['7520']
    + ink2r['7417'] - ink2r['7521'] - ink2r['7522']

  // Bokslutsdispositioner 3.19–3.24.
  const bokslutsdispositioner =
    - ink2r['7524'] + ink2r['7419'] + ink2r['7420'] - ink2r['7525']
    + ink2r['7421'] - ink2r['7526'] + ink2r['7422'] - ink2r['7527']

  const resultBeforeTax = operatingResult + financialItems + bokslutsdispositioner

  // 3.26/3.27 Årets resultat (after 3.25 skatt).
  const resultAfterFinancial = resultBeforeTax - ink2r['7528']
  ink2r['7450'] = resultAfterFinancial >= 0 ? resultAfterFinancial : 0
  ink2r['7550'] = resultAfterFinancial < 0 ? Math.abs(resultAfterFinancial) : 0

  // Fritt eget kapital (2.28) includes årets resultat. The closing vouchers are
  // excluded above, so add the computed result here.
  ink2r['7302'] += resultAfterFinancial
  breakdown['7302'].accounts.push({ accountNumber: '2099', accountName: 'Årets resultat (beräknat)', amount: resultAfterFinancial })
  breakdown['7302'].total = ink2r['7302']

  const totalAssets = ASSET_CODES.reduce((sum, code) => sum + ink2r[code], 0)
  const totalEquityLiabilities = EQUITY_LIABILITY_CODES.reduce((sum, code) => sum + ink2r[code], 0)
  const adjustedEquityLiabilities = totalEquityLiabilities

  // Fiscal year dates as YYYYMMDD
  const fyStart = (period.period_start as string).replace(/-/g, '')
  const fyEnd = (period.period_end as string).replace(/-/g, '')

  const adjustments = await listTaxDeclarationAdjustments(supabase, companyId, fiscalPeriodId, 'INK2')
  const pendingAdjustmentMessages = pendingAdjustmentWarnings(adjustments)

  // INK2S. Derived where the ledger decides it (4.1/4.2 result, 4.3a tax);
  // everything else comes from approved tax_declaration_adjustments. Two
  // additions have a safe default when no adjustment exists: 4.3c from the BAS
  // accounts that are by definition non-deductible, and 4.6a schablonintäkt
  // from the periodiseringsfonder at the start of the year.
  const ink2s = createEmptyINK2SRutor(fyStart, fyEnd)
  ink2s['7650'] = resultAfterFinancial >= 0 ? resultAfterFinancial : 0
  ink2s['7750'] = resultAfterFinancial < 0 ? Math.abs(resultAfterFinancial) : 0
  ink2s['7651'] = ink2r['7528']

  for (const code of INK2S_ADJUSTABLE_CODES) {
    if (code === '7651') continue
    ink2s[code] = truncateToKrona(approvedAdjustmentAmount(adjustments, code))
  }

  const hasAdjustment = (code: string) => adjustments.some((row) => row.field_code === code)

  const nonDeductible = sumNonDeductibleCosts(accountBalances)
  if (!hasAdjustment('7653') && nonDeductible > 0) {
    ink2s['7653'] = nonDeductible
  }

  const schablon = await estimatePeriodiseringsfondSchablon(supabase, companyId, fiscalPeriodId, period.period_start, period.period_end)
  if (!hasAdjustment('7654') && schablon.amount > 0) {
    ink2s['7654'] = schablon.amount
  }

  const additions = sumInk2SFields(ink2s, INK2S_ADDITION_CODES)
  const deductions = sumInk2SFields(ink2s, INK2S_DEDUCTION_CODES)
  const taxableResult = resultAfterFinancial + additions - deductions
  ink2s['7670'] = taxableResult >= 0 ? truncateToKrona(taxableResult) : 0
  ink2s['7770'] = taxableResult < 0 ? truncateToKrona(Math.abs(taxableResult)) : 0

  const ink2: INK2Rutor = {
    '7011': fyStart,
    '7012': fyEnd,
    '7104': ink2s['7670'],
    '7114': ink2s['7770'],
  }

  const readinessIssues = [
    issue('ink2r_mapped', 'ok', 'INK2R har beräknats från bokförda konton.', 'ink2-engine'),
    issue('ink2s_calculated', 'ok', 'INK2S har beräknats från resultat, skatt och godkända skattemässiga justeringar.', 'ink2-engine'),
  ]

  if (!(period as FiscalPeriod).is_closed) {
    const message = 'Räkenskapsåret är inte stängt. Stäng bokslutet innan deklarationspaketet markeras som färdigt.'
    warnings.push(message)
    readinessIssues.push(issue('fiscal_period_open', 'blocker', message, 'fiscal_periods'))
  }

  if (totalAssets === 0 && totalEquityLiabilities === 0 && ink2r['7410'] === 0) {
    const message = 'Inga bokförda transaktioner hittades för perioden.'
    warnings.push(message)
    readinessIssues.push(issue('no_bookkeeping_data', 'blocker', message, 'journal_entries'))
  }

  const balanceWarning = checkBalanceWarning(totalAssets, adjustedEquityLiabilities)
  if (balanceWarning) {
    warnings.push(balanceWarning)
    readinessIssues.push(issue('balance_sheet_unbalanced', 'blocker', balanceWarning, 'ink2r'))
  }

  for (const message of pendingAdjustmentMessages) {
    warnings.push(message)
    readinessIssues.push(issue('tax_adjustment_needs_review', 'warning', message, 'tax_declaration_adjustments'))
  }

  if (nonDeductible > 0 && hasAdjustment('7653')) {
    const message = `Ej avdragsgilla kostnader på ${nonDeductible} kr finns i bokföringen; ruta 7653 styrs av en manuell justering. Kontrollera att den täcker dem.`
    warnings.push(message)
    readinessIssues.push(issue('possible_non_deductible_expenses', 'warning', message, 'account_rules'))
  }

  if (ink2r['7321'] > 0 && !hasAdjustment('7654') && schablon.rate === null) {
    const message = 'Periodiseringsfond finns men statslåneräntan för året saknas, så schablonintäkten (ruta 7654) kunde inte beräknas.'
    warnings.push(message)
    readinessIssues.push(issue('periodiseringsfond_schablon_missing', 'blocker', message, 'ink2s'))
  }

  if (ink2r['7522'] >= 5_000_000) {
    const message = 'Räntekostnader är höga. Kontrollera om ränteavdragsbegränsning/N9 behövs innan export markeras som färdig.'
    warnings.push(message)
    readinessIssues.push(issue('n9_detector_interest_limit', 'blocker', message, 'appendix_detector'))
  }

  if (sumAccountRange(accountBalances, '1310', '1379') > 0) {
    const message = 'Andelar/finansiella innehav finns i bokföringen. Kontrollera skattefri utdelning, kapitalvinst/förlust och eventuell extra bilaga.'
    warnings.push(message)
    readinessIssues.push(issue('financial_holdings_review', 'warning', message, 'appendix_detector'))
  }

  const readiness = buildDeclarationReadiness(readinessIssues)

  return {
    fiscalYear: {
      id: period.id,
      name: period.name,
      start: period.period_start,
      end: period.period_end,
      isClosed: period.is_closed,
    },
    ink2,
    ink2r,
    ink2s,
    breakdown,
    totals: {
      totalAssets,
      totalEquityLiabilities: adjustedEquityLiabilities,
      operatingResult,
      resultAfterFinancial,
    },
    companyInfo: {
      companyName: settings?.company_name || 'Okänt företag',
      orgNumber: settings?.org_number || null,
      addressLine1: settings?.address_line1 || null,
      postalCode: settings?.postal_code || null,
      city: settings?.city || null,
      email: settings?.email || null,
    },
    warnings,
    taxAnalysis: {
      taxableResult: truncateToKrona(taxableResult),
      additions: truncateToKrona(additions),
      deductions: truncateToKrona(deductions),
      pendingAdjustmentCount: pendingAdjustmentMessages.length,
      blockerCount: readiness.blockers.length,
      readinessScore: readiness.score,
      status: readiness.status,
      issues: [...readiness.completed, ...readiness.warnings, ...readiness.blockers],
    },
  }
}
