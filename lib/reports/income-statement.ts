import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from './trial-balance'
import type { IncomeStatementReport, IncomeStatementSection, TrialBalanceRow } from '@/types'
import { roundOre } from '@/lib/money'

/**
 * Generate Income Statement (Resultaträkning)
 *
 * Filters to class 3-8 accounts:
 * - Rörelseintäkter (3xxx): Revenue
 * - Rörelsekostnader (4-7xxx): Operating expenses
 * - Finansiella poster (8xxx): Financial items
 * - Årets resultat: Net result
 */
export async function generateIncomeStatement(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  options?: { fromDate?: string; toDate?: string }
): Promise<IncomeStatementReport> {
  // Exclude year-end closing entries: after closing, P&L accounts (3-8) are
  // zeroed by the closing verifikat (8999 → 2099). Including them collapses
  // the resultaträkning to zero. The income statement must reflect the
  // pre-closing activity for the year.
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    excludeYearEndClosing: true,
    fromDate: options?.fromDate,
    toDate: options?.toDate,
  })

  // Filter to income/expense accounts (class 3-8)
  const incomeExpenseRows = rows.filter(
    (r) => r.account_class >= 3 && r.account_class <= 8
  )

  // Revenue sections (class 3)
  const revenueSections = buildSections(
    incomeExpenseRows.filter((r) => r.account_class === 3),
    {
      '30': 'Huvudintäkter',
      '31': 'Försäljning av varor utanför Sverige',
      '32': 'Försäljning VMB och omvänd moms',
      '33': 'Försäljning av tjänster utanför Sverige',
      '34': 'Egna uttag',
      '35': 'Fakturerade kostnader',
      '36': 'Sidointäkter',
      '37': 'Intäktskorrigeringar',
      '38': 'Aktiverat arbete',
      '39': 'Övriga rörelseintäkter',
    },
    'credit' // Revenue has credit normal balance
  )

  // Expense sections (class 4-7)
  const expenseSections = buildSections(
    incomeExpenseRows.filter((r) => r.account_class >= 4 && r.account_class <= 7),
    {
      '40': 'Varor och material',
      '41': 'Förändring lager',
      '42': 'Sålda handelsvaror VMB',
      '43': 'Råvaror och material',
      '44': 'Inköp omvänd betalningsskyldighet',
      '45': 'Inköp utlandet',
      '46': 'Underentreprenader och legoarbeten',
      '47': 'Erhållna rabatter',
      '48': 'Andra produktionskostnader',
      '49': 'Lagerförändringar',
      '50': 'Lokalkostnader',
      '51': 'Fastighetskostnader',
      '52': 'Hyra av tillgångar',
      '53': 'Energikostnader',
      '54': 'Förbrukningsinventarier',
      '55': 'Reparation och underhåll',
      '56': 'Transportkostnader',
      '57': 'Frakter och transporter',
      '58': 'Resekostnader',
      '59': 'Reklam och PR',
      '60': 'Övriga försäljningskostnader',
      '61': 'Kontorsmateriel',
      '62': 'Tele och post',
      '63': 'Försäkringar och riskkostnader',
      '64': 'Förvaltningskostnader',
      '65': 'Övriga externa tjänster',
      '67': 'Särskilt för ideella föreningar och stiftelser',
      '68': 'Inhyrd personal',
      '69': 'Övriga kostnader',
      '70': 'Löner kollektivanställda',
      '72': 'Löner tjänstemän/företagsledare',
      '73': 'Kostnadsersättningar och förmåner',
      '74': 'Pensionskostnader',
      '75': 'Sociala avgifter',
      '76': 'Övriga personalkostnader',
      '77': 'Nedskrivningar',
      '78': 'Avskrivningar',
      '79': 'Övriga rörelsekostnader',
    },
    'debit' // Expenses have debit normal balance
  )

  // Financial sections (class 8) — exclude 899x "Årets resultat".
  // 899x is a closing group: when year-end posts "8999 debit → 2099 credit"
  // to move the computed profit into equity, including its debit balance
  // here cancels out the revenue/expense difference and drives net_result to
  // zero. The income statement shows the *computed* årets resultat as
  // (revenue - expenses + financial), so 899x's own balance must stay out.
  const financialSections = buildSections(
    incomeExpenseRows.filter(
      (r) => r.account_class === 8 && !r.account_number.startsWith('899')
    ),
    {
      '80': 'Resultat andelar koncernföretag',
      '81': 'Resultat andelar intresseföretag',
      '82': 'Resultat övriga värdepapper',
      '83': 'Ränteintäkter',
      '84': 'Räntekostnader',
      '88': 'Bokslutsdispositioner',
      '89': 'Skatter och årets resultat',
    },
    'mixed'
  )

  const totalRevenue = revenueSections.reduce((sum, s) => sum + s.subtotal, 0)
  const totalExpenses = expenseSections.reduce((sum, s) => sum + s.subtotal, 0)
  const totalFinancial = financialSections.reduce((sum, s) => sum + s.subtotal, 0)

  return {
    revenue_sections: revenueSections.filter((s) => s.rows.length > 0),
    total_revenue: roundOre(totalRevenue),
    expense_sections: expenseSections.filter((s) => s.rows.length > 0),
    total_expenses: roundOre(totalExpenses),
    financial_sections: financialSections.filter((s) => s.rows.length > 0),
    total_financial: roundOre(totalFinancial),
    net_result: roundOre(totalRevenue - totalExpenses + totalFinancial),
    period: { start: '', end: '' }, // Will be filled by caller
  }
}

/**
 * Build report sections from trial balance rows.
 *
 * Every row lands in exactly one section: rows whose two-digit group has no
 * label get a section of their own, titled from the group's first account.
 * Before this, a group missing from the label map (48 andra
 * produktionskostnader, 53 energi, 67 …) silently vanished from the totals and
 * from årets resultat.
 */
function buildSections(
  rows: TrialBalanceRow[],
  groupLabels: Record<string, string>,
  normalBalance: 'debit' | 'credit' | 'mixed'
): IncomeStatementSection[] {
  const sections: IncomeStatementSection[] = []

  const groups = new Map<string, TrialBalanceRow[]>()
  for (const row of rows) {
    const group = row.account_number.slice(0, 2)
    const list = groups.get(group) ?? []
    list.push(row)
    groups.set(group, list)
  }

  const orderedGroups = [...groups.keys()].sort()
  for (const groupCode of orderedGroups) {
    const groupRows = groups.get(groupCode)!
    const title = groupLabels[groupCode] ?? `${groupRows[0]?.account_name ?? 'Övrigt'} (${groupCode}xx)`

    const sectionRows = groupRows.map((r) => {
      let amount: number
      if (normalBalance === 'credit') {
        // Revenue: credit - debit (positive = revenue)
        amount = r.closing_credit - r.closing_debit
      } else if (normalBalance === 'debit') {
        // Expense: debit - credit (positive = expense)
        amount = r.closing_debit - r.closing_credit
      } else {
        // Mixed: net balance (financial items)
        amount = r.closing_credit - r.closing_debit
      }

      return {
        account_number: r.account_number,
        account_name: r.account_name,
        amount: roundOre(amount),
      }
    })

    const subtotal = sectionRows.reduce((sum, r) => sum + r.amount, 0)

    sections.push({
      title,
      rows: sectionRows.filter((r) => Math.abs(r.amount) > 0.005),
      subtotal: roundOre(subtotal),
    })
  }

  return sections
}
