import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { getActiveCompanyId } from '@/lib/company/context'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'
import { getWorklistCounts, listSuggestedMatches } from '@/lib/worklist'
import { resolveDashboardWorkspaceState } from '@/lib/dashboard/workspace-state'
import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { stockholmToday, stockholmStartOfMonth } from '@/lib/dates/stockholm'
import type { Deadline } from '@/types'

export const dynamic = 'force-dynamic'

// Home route = Översikt. A provisioned company can always reach the dashboard;
// optional onboarding is shown as inline next steps and never blocks accounting.

export default async function DashboardPage() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // user_preferences + resolveCompanyAccess is the single access source for
  // direct members, agency staff and platform admins.
  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  // Date boundaries in Europe/Stockholm (R21) — never raw UTC days.
  const now = new Date()
  const today = stockholmToday(now)
  const startOfMonthStr = stockholmStartOfMonth(now)
  const nextWeek = stockholmToday(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000))

  // Active fiscal period (R15): YTD follows the company's räkenskapsår —
  // which may be broken (brutet) — not the calendar year.
  const { data: activePeriod, error: activePeriodError } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .lte('period_start', today)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Fetch all data in parallel
  const [
    { data: settings },
    { count: customerCount },
    { count: invoiceCount },
    { count: receiptCount },
    { count: transactionCount },
    unpaidInvoicesResult,
    bankConnectionsResult,
    { data: deadlines },
    { count: sieImportCount },
    { count: staleUncategorizedCount },
    { count: skatteverketTokenCount },
    { data: agentProfile },
    { count: postedEntriesCount },
    worklist,
    suggestedMatches,
  ] = await Promise.all([
    supabase.from('company_settings').select('*').eq('company_id', companyId).single(),
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('receipts').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    // Unpaid AR (R18): every open status, remaining_amount not invoice total.
    supabase
      .from('invoices')
      .select('total, total_sek, paid_amount, remaining_amount, currency, exchange_rate, vat_amount, vat_amount_sek, status')
      .eq('company_id', companyId)
      .in('status', ['sent', 'overdue', 'partially_paid', 'disputed', 'collection_ready'])
      .is('credited_invoice_id', null),
    supabase.from('bank_connections').select('id, accounts_data, status, consent_expires, bank_name, last_synced_at').eq('company_id', companyId).eq('status', 'active'),
    supabase.from('deadlines').select('*, customer:customers(id, name)').eq('company_id', companyId).eq('is_completed', false)
      .or(`due_date.lt.${today},due_date.lte.${nextWeek}`).order('due_date', { ascending: true }),
    supabase.from('sie_imports').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'completed'),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId).is('journal_entry_id', null).eq('is_ignored', false).is('is_business', null).lt('date', new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]),
    // Skatteverket connection status is COMPANY-scoped: the token authorizes
    // filings for this company's org number (unique per company_id since the
    // multi-tenant refactor). Filtering by user_id showed "connected" for the
    // wrong company when a user works across multiple companies. Reads go
    // through the metadata view — the token table itself is service-role only.
    supabase.from('skatteverket_connections_v').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('agent_profiles').select('verified_at').eq('company_id', companyId).maybeSingle(),
    // Any posted entry counts as real dashboard activity for workspace state.
    supabase.from('journal_entries').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'posted'),
    // Pending-work counts + suggested matches come from lib/worklist — the
    // same source as the sidebar badges, so the numbers can never diverge.
    getWorklistCounts(supabase, companyId),
    listSuggestedMatches(supabase, companyId, 5),
  ])

  // Sandbox sessions that pre-date the agent_profile seeding step would
  // otherwise still see the optional "Bygg din bokföringsassistent" hero.
  // Backfill here so the next render sees a verified profile and treats the
  // sandbox as fully set up.
  let effectiveAgentVerified = agentProfile?.verified_at ?? null
  if (settings?.is_sandbox === true && !effectiveAgentVerified) {
    await ensureSandboxAgentProfile(supabase, companyId)
    const { data: refreshed } = await supabase
      .from('agent_profiles')
      .select('verified_at')
      .eq('company_id', companyId)
      .maybeSingle()
    effectiveAgentVerified = refreshed?.verified_at ?? null
  }

  const agentBuilt = Boolean(effectiveAgentVerified)

  // A provisioned company should always land on /app. Bank, SIE,
  // Skatteverket and assistant setup are optional dashboard actions, not
  // routing gates. Keep the state in one helper so UI and progress cards do
  // not drift apart.
  const workspaceState = resolveDashboardWorkspaceState({
    customerCount,
    invoiceCount,
    receiptCount,
    transactionCount,
    postedEntriesCount,
    sieImportCount,
    bankConnectionCount: bankConnectionsResult.data?.length ?? 0,
    skatteverketTokenCount,
  })

  // Load errors are surfaced as errors, never silently rendered as 0 kr (R20).
  const dataErrors: { result?: string; invoices?: string; bank?: string } = {}

  // Result KPI (R16/R17): the SAME canonical report engine as the formal
  // reports — generateResultatrapport on the active fiscal period (movement
  // for the selected window, class 3–8 incl. financial items, year-end
  // closing excluded, paginated trial balance underneath).
  const sumClasses = (
    report: Awaited<ReturnType<typeof generateResultatrapport>>,
    classes: number[],
  ) =>
    Math.round(
      report.groups
        .filter((g) => classes.includes(g.class))
        .reduce((sum, g) => sum + g.subtotal_current, 0) * 100,
    ) / 100

  let ytdTotals: { income: number; expenses: number; net: number } | null = null
  let mtdTotals: { income: number; expenses: number; net: number } | null = null
  let fiscalYearStart: string | null = null

  if (activePeriodError) {
    dataErrors.result = 'Räkenskapsåret kunde inte läsas'
  } else if (activePeriod) {
    fiscalYearStart = activePeriod.period_start as string
    try {
      const clampedToday = today <= activePeriod.period_end ? today : (activePeriod.period_end as string)
      const monthFrom =
        startOfMonthStr >= activePeriod.period_start ? startOfMonthStr : (activePeriod.period_start as string)
      const [ytdReport, mtdReport] = await Promise.all([
        generateResultatrapport(supabase, companyId, activePeriod.id, { toDate: clampedToday }),
        generateResultatrapport(supabase, companyId, activePeriod.id, {
          fromDate: monthFrom,
          toDate: clampedToday,
        }),
      ])
      // KPI definition: "resultat" = the full net result incl. class 8
      // (financial items, dispositions, tax) — the same net as the formal
      // resultatrapport. income = class 3, expenses = classes 4–8 (positive).
      ytdTotals = {
        income: sumClasses(ytdReport, [3]),
        expenses: Math.round(-sumClasses(ytdReport, [4, 5, 6, 7, 8]) * 100) / 100,
        net: ytdReport.net_result_current,
      }
      mtdTotals = {
        income: sumClasses(mtdReport, [3]),
        expenses: Math.round(-sumClasses(mtdReport, [4, 5, 6, 7, 8]) * 100) / 100,
        net: mtdReport.net_result_current,
      }
    } catch {
      dataErrors.result = 'Resultatet kunde inte laddas'
    }
  } else {
    // No fiscal period yet — a legitimate empty state, not an error.
    ytdTotals = { income: 0, expenses: 0, net: 0 }
    mtdTotals = { income: 0, expenses: 0, net: 0 }
  }

  // Unpaid AR (R18): remaining_amount per open invoice, converted to SEK.
  const unpaidInvoices = unpaidInvoicesResult.data
  if (unpaidInvoicesResult.error) {
    dataErrors.invoices = 'Kundfordringarna kunde inte laddas'
  }
  const openRemainingSek = (inv: {
    total: number | null
    total_sek: number | null
    paid_amount: number | null
    remaining_amount: number | null
    currency: string | null
    exchange_rate: number | null
  }): number => {
    const remaining = Number(
      inv.remaining_amount ?? (Number(inv.total) || 0) - (Number(inv.paid_amount) || 0),
    )
    if (!inv.currency || inv.currency === 'SEK') return remaining
    if (inv.exchange_rate && Number(inv.exchange_rate) > 0) {
      return Math.round(remaining * Number(inv.exchange_rate) * 100) / 100
    }
    // FX without a rate cannot be converted — fall back to the booked SEK
    // proportion of the total when available.
    if (inv.total_sek && inv.total) {
      return Math.round(remaining * (Number(inv.total_sek) / Number(inv.total)) * 100) / 100
    }
    return 0
  }

  const unpaidTotal = (unpaidInvoices || []).reduce(
    (sum, inv) =>
      sum +
      getDisplayTotal({ total: openRemainingSek(inv), currency: 'SEK' }, settings).displayed,
    0,
  )

  const unpaidVatTotal = (unpaidInvoices || []).reduce(
    (sum, inv) => sum + Number(inv.vat_amount_sek || inv.vat_amount || 0),
    0
  )

  const overdueCount = (unpaidInvoices || []).filter(
    (inv) => inv.status === 'overdue'
  ).length

  // Bank liquidity (R19): dedupe accounts across (re)connected connections by
  // IBAN/uid so a reconnect never double-counts, and surface freshness.
  const bankConnections = bankConnectionsResult.data
  if (bankConnectionsResult.error) {
    dataErrors.bank = 'Banksaldot kunde inte laddas'
  }
  let bankBalance: number | null = null
  let bankBalanceStale = false
  let bankBalanceAsOf: string | null = null
  if (bankConnections && bankConnections.length > 0) {
    type AccountData = {
      uid?: string
      iban?: string
      balance?: number
      currency?: string
      balance_updated_at?: string
      enabled?: boolean
    }
    const seen = new Map<string, AccountData & { last_synced_at: string | null }>()
    for (const conn of bankConnections) {
      const accounts = (conn.accounts_data as AccountData[] | null) || []
      for (const acc of accounts) {
        if (acc.enabled === false) continue
        const key = (acc.iban?.replace(/\s+/g, '').toUpperCase() || acc.uid || '') as string
        if (!key) continue
        const existing = seen.get(key)
        const candidate = { ...acc, last_synced_at: (conn.last_synced_at as string | null) ?? null }
        if (
          !existing ||
          (candidate.balance_updated_at ?? '') > (existing.balance_updated_at ?? '')
        ) {
          seen.set(key, candidate)
        }
      }
    }
    if (seen.size > 0) {
      bankBalance = [...seen.values()].reduce((sum, acc) => sum + (acc.balance || 0), 0)
      const updatedDates = [...seen.values()]
        .map((a) => a.balance_updated_at ?? a.last_synced_at)
        .filter((d): d is string => Boolean(d))
      bankBalanceAsOf = updatedDates.length > 0 ? updatedDates.reduce((a, b) => (a < b ? a : b)) : null
      // Cached balance older than 48h is flagged stale.
      bankBalanceStale =
        bankBalanceAsOf !== null &&
        Date.now() - new Date(bankBalanceAsOf).getTime() > 48 * 60 * 60 * 1000
    }
  }

  const nowMs = new Date().getTime()
  const expiringBankConnections = (bankConnections || [])
    .filter(conn => {
      if (!conn.consent_expires) return false
      const daysLeft = Math.ceil(
        (new Date(conn.consent_expires).getTime() - nowMs) / (1000 * 60 * 60 * 24)
      )
      return daysLeft > 0 && daysLeft <= 14
    })
    .map(conn => ({
      id: conn.id as string,
      bank_name: conn.bank_name as string,
      days_left: Math.ceil(
        (new Date(conn.consent_expires!).getTime() - nowMs) / (1000 * 60 * 60 * 24)
      ),
    }))

  return (
    <DashboardContent
      companyId={companyId}
      agentBuilt={agentBuilt}
      summary={{
        ytd: ytdTotals ?? { income: 0, expenses: 0, net: 0 },
        mtd: mtdTotals ?? { income: 0, expenses: 0, net: 0 },
        fiscalYearStart,
        dataErrors,
        unpaidInvoicesCount: (unpaidInvoices || []).length,
        unpaidInvoicesTotal: unpaidTotal,
        unpaidVatTotal,
        overdueInvoicesCount: overdueCount,
        bankBalance,
        bankBalanceStale,
        bankBalanceAsOf,
        expiringBankConnections,
        deadlines: (deadlines || []) as Deadline[],
        staleUncategorizedCount: staleUncategorizedCount || 0,
      }}
      worklist={worklist}
      suggestedMatches={suggestedMatches}
      onboardingProgress={workspaceState.onboardingProgress}
      isEmptyWorkspace={workspaceState.isEmptyWorkspace}
    />
  )
}
