import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { FiscalPeriod } from '@/types'
import { buildDeclarationReadiness, issue } from '@/lib/tax-declaration/readiness'
import { fetchPeriodAccountNets } from '@/lib/reports/period-account-nets'
import type {
  NEBalanceRutor,
  NEDeclaration,
  NEDeclarationRutor,
} from './types'

export { NE_ACCOUNT_MAPPINGS, NE_BALANCE_MAPPINGS, findNEMapping } from './account-mappings'
import { NE_ACCOUNT_MAPPINGS, NE_BALANCE_MAPPINGS, findNEMapping } from './account-mappings'

/** Whole kronor, truncated toward zero like INK2 (SRU amounts carry no öre). */
function toKrona(value: number): number {
  return value >= 0 ? Math.floor(value) : Math.ceil(value)
}

function emptyRutor(): NEDeclarationRutor {
  return { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0, R7: 0, R8: 0, R9: 0, R10: 0, R11: 0 }
}

function emptyBalance(): NEBalanceRutor {
  return {
    B1: 0, B2: 0, B3: 0, B4: 0, B5: 0, B6: 0, B7: 0, B8: 0, B9: 0,
    B10: 0, B11: 0, B12: 0, B13: 0, B14: 0, B15: 0, B16: 0,
  }
}

/**
 * Generate NE declaration for a fiscal period
 */
export async function generateNEDeclaration(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string
): Promise<NEDeclaration> {

  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()

  if (periodError || !period) {
    throw new Error('Fiscal period not found')
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name, org_number, entity_type, vat_registered, voluntary_vat_rental')
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

  if (entityType !== 'enskild_firma') {
    throw new Error('NE declaration is only for enskild firma (sole proprietorship)')
  }

  // Year-end closing vouchers move the result into 2010 inside the period; the
  // declaration must read the result from the accounts (see INK2).
  const accountBalances = await fetchPeriodAccountNets(supabase, companyId, fiscalPeriodId, {
    excludeYearEndClosing: true,
  })

  const accounts = await fetchAllRows<{ account_number: string; account_name: string }>(({ from, to }) =>
    supabase
      .from('chart_of_accounts')
      .select('account_number, account_name')
      .eq('company_id', companyId)
      .order('account_number', { ascending: true })
      .range(from, to)
  )
  const accountNameMap = new Map<string, string>()
  for (const acc of accounts) accountNameMap.set(acc.account_number, acc.account_name)
  const nameOf = (account: string) => accountNameMap.get(account) || `Konto ${account}`

  const momsfriVerksamhet = settings?.vat_registered === false
  const voluntaryRental = settings?.voluntary_vat_rental === true

  const rutor = emptyRutor()
  const balance = emptyBalance()
  const breakdown = Object.fromEntries(
    (Object.keys(rutor) as (keyof NEDeclarationRutor)[]).map((k) => [k, { accounts: [], total: 0 }]),
  ) as unknown as NEDeclaration['breakdown']

  const warnings: string[] = []
  let equityAccounts = 0

  for (const [accountNumber, net] of accountBalances) {
    if (Math.abs(net) < 0.01) continue
    const cls = accountNumber.charAt(0)

    if (cls === '1' || cls === '2') {
      if (accountNumber >= '2000' && accountNumber <= '2099') {
        equityAccounts += -net
        continue
      }
      const row = NE_BALANCE_MAPPINGS.find((m) => m.ranges.some(([a, b]) => accountNumber >= a && accountNumber <= b))
      if (!row) {
        warnings.push(`Konto ${accountNumber} (${nameOf(accountNumber)}) kunde inte placeras i NE:s balansräkning.`)
        continue
      }
      balance[row.row] += row.asset ? net : -net
      if (row.row === 'B16' && accountNumber >= '2500' && accountNumber <= '2599') {
        warnings.push(`Konto ${accountNumber} (${nameOf(accountNumber)}) är en skatteskuld. För enskild firma är skatten privat — kontrollera om beloppet ska bokas mot eget kapital.`)
      }
      continue
    }

    // 899x = årets resultat, calculated below; 89xx otherwise is income tax,
    // which a sole trader does not book in the business.
    if (accountNumber >= '8900' && accountNumber <= '8999') {
      if (accountNumber < '8990') warnings.push(`Konto ${accountNumber} (${nameOf(accountNumber)}) används inte i enskild firma och har inte tagits med i NE.`)
      continue
    }

    let mapping = findNEMapping(accountNumber, net, momsfriVerksamhet)
    if (mapping && mapping.ruta === 'R2' && (accountNumber === '3911' || accountNumber === '3912') && voluntaryRental) {
      mapping = NE_ACCOUNT_MAPPINGS.find((m) => m.ruta === 'R1') ?? mapping
    }
    if (!mapping) {
      warnings.push(`Konto ${accountNumber} (${nameOf(accountNumber)}) kunde inte mappas till en NE-ruta och ingår inte i R1–R10.`)
      continue
    }

    const amount = mapping.isExpense ? net : -net
    rutor[mapping.ruta] += amount
    breakdown[mapping.ruta].accounts.push({
      accountNumber,
      accountName: nameOf(accountNumber),
      amount: toKrona(amount),
    })
  }

  for (const key of Object.keys(rutor) as (keyof NEDeclarationRutor)[]) {
    if (key === 'R11') continue
    rutor[key] = toKrona(rutor[key])
    breakdown[key].total = rutor[key]
  }

  // R11 Bokfört resultat
  const totalRevenue = rutor.R1 + rutor.R2 + rutor.R3 + rutor.R4
  const totalExpenses = rutor.R5 + rutor.R6 + rutor.R7 + rutor.R8 + rutor.R9 + rutor.R10
  rutor.R11 = totalRevenue - totalExpenses
  breakdown.R11.total = rutor.R11

  // B1–B16 in whole kronor; B10 = tillgångar − skulder as the form defines it.
  for (const key of Object.keys(balance) as (keyof NEBalanceRutor)[]) balance[key] = toKrona(balance[key])
  const assets = balance.B1 + balance.B2 + balance.B3 + balance.B4 + balance.B5 + balance.B6 + balance.B7 + balance.B8 + balance.B9
  const liabilities = balance.B11 + balance.B12 + balance.B13 + balance.B14 + balance.B15 + balance.B16
  balance.B10 = assets - liabilities

  // B10 must equal the bookkept equity (20xx) plus the year's result.
  const bookedEquity = toKrona(equityAccounts) + rutor.R11
  if (Math.abs(balance.B10 - bookedEquity) > 2 && (assets !== 0 || liabilities !== 0)) {
    warnings.push(`Eget kapital enligt NE (${balance.B10} kr) stämmer inte med bokfört eget kapital plus årets resultat (${bookedEquity} kr). Kontrollera omappade konton.`)
  }

  if (!(period as FiscalPeriod).is_closed) {
    warnings.push('Räkenskapsåret är inte stängt — deklarationen kan genereras, men siffrorna kan ändras om fler bokföringar görs.')
  }

  if (rutor.R11 === 0 && totalRevenue === 0) {
    warnings.push('Inga bokförda intäkter eller kostnader hittades för perioden.')
  }

  const readinessIssues = [
    issue('ne_r1_r11_calculated', 'ok', 'NE R1–R11 och B1–B16 har beräknats från bokföringen.', 'ne-engine'),
    issue('ne_r12_r48_requires_questionnaire', 'blocker', 'NE R12–R48 kräver komplett EF-frågeflöde för egenavgifter, räntefördelning, expansionsfond, periodiseringsfond, underskott och privata poster innan export kan markeras som färdig.', 'ne-engine'),
  ]
  if (!period.is_closed) {
    readinessIssues.push(issue('fiscal_period_open', 'blocker', 'Räkenskapsåret är inte stängt.', 'fiscal_periods'))
  }
  for (const message of warnings) {
    readinessIssues.push(issue('ne_warning', 'warning', message, 'ne-engine'))
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
    rutor,
    balance,
    breakdown,
    companyInfo: {
      companyName: settings?.company_name || 'Okänt företag',
      orgNumber: settings?.org_number || null,
    },
    warnings,
    taxAnalysis: {
      readinessScore: readiness.score,
      status: readiness.status,
      blockerCount: readiness.blockers.length,
      issues: [...readiness.completed, ...readiness.warnings, ...readiness.blockers],
    },
  }
}

/**
 * Get totals for display
 */
export function getNEDeclarationTotals(declaration: NEDeclaration): {
  totalRevenue: number
  totalExpenses: number
  netResult: number
} {
  const { rutor } = declaration

  return {
    totalRevenue: rutor.R1 + rutor.R2 + rutor.R3 + rutor.R4,
    totalExpenses: rutor.R5 + rutor.R6 + rutor.R7 + rutor.R8 + rutor.R9 + rutor.R10,
    netResult: rutor.R11,
  }
}
