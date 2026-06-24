import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { listCompanyFeatureAccess } from '@/lib/platform/entitlements'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'


const statusLabel = (status?: string | null) => {
  const labels: Record<string, string> = {
    active: 'Aktiv',
    draft: 'Utkast',
    open: 'Öppen',
    in_review: 'Under granskning',
    paused: 'Pausad',
    disabled: 'Avstängd',
  }
  return labels[status ?? ''] ?? status ?? '–'
}

const priorityLabel = (priority?: string | null) => {
  const labels: Record<string, string> = {
    urgent: 'Brådskande',
    high: 'Hög',
    normal: 'Normal',
    low: 'Låg',
  }
  return labels[priority ?? ''] ?? priority ?? '–'
}

const ruleTypeLabel = (ruleType?: string | null) => {
  const labels: Record<string, string> = {
    bank_fee: 'Bankavgift',
    supplier_invoice: 'Leverantörsfaktura',
    customer_payment: 'Kundbetalning',
    transfer: 'Överföring',
    recurring: 'Återkommande händelse',
  }
  return labels[ruleType ?? ''] ?? (ruleType ? ruleType.replaceAll('_', ' ') : 'Regel')
}

type ReviewItem = {
  id: string
  title: string
  description: string | null
  priority: string
  status: string
  confidence: number | null
  created_at: string
}

type RuleRow = {
  id: string
  name: string
  rule_type: string
  min_confidence: number
  auto_book_allowed: boolean
  requires_review: boolean
  status: string
}

export default async function BankAutomationPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  const [
    features,
    { count: bankConnections },
    { count: bankAccounts },
    { count: transactionsToReview },
    { count: suggestedTransactions },
    { count: autoBookedTransactions },
    { data: reviewItems },
    { data: rules },
  ] = await Promise.all([
    listCompanyFeatureAccess(supabase, companyId),
    supabase.from('bank_connections').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'active'),
    supabase.from('bank_accounts').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'active'),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('automation_status', 'needs_review'),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('automation_status', 'suggested'),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('automation_status', 'auto_booked'),
    supabase.from('review_queue_items').select('id, title, description, priority, status, confidence, created_at').eq('company_id', companyId).in('status', ['open', 'in_review']).order('created_at', { ascending: false }).limit(8),
    supabase.from('bookkeeping_automation_rules').select('id, name, rule_type, min_confidence, auto_book_allowed, requires_review, status').eq('company_id', companyId).order('created_at', { ascending: false }).limit(8),
  ])

  const hasBankAutomation = features.some((feature) => feature.feature_code === 'bank.automation' && feature.enabled)
  return (
    <NordklartPageShell
      eyebrow="Bankautomation"
      title="Automatiserad bokföring med granskning först"
      description="Transaktioner importeras, matchas mot regler och fakturor och får en tydlig säkerhetsnivå. Säkra händelser kan bokföras automatiskt, medan osäkra händelser hamnar i granskning."
      actions={<Button asChild variant="secondary"><Link href="/transactions">Visa transaktioner</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Tjänst" value={hasBankAutomation ? 'Aktiv' : 'Ej aktiv'} description="Ingår i din aktiva plan." tone={hasBankAutomation ? 'success' : 'warning'} />
        <NordklartStatCard label="Bankkopplingar" value={bankConnections ?? 0} description="Aktiva bankkopplingar." />
        <NordklartStatCard label="Bankkonton" value={bankAccounts ?? 0} description="Normaliserade bankkonton." />
        <NordklartStatCard label="Granska" value={transactionsToReview ?? 0} description="Osäkra händelser eller hög risk." tone="warning" />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <NordklartStatCard label="Förslag" value={suggestedTransactions ?? 0} description="Behöver kontroll innan bokföring." tone="primary" />
        <NordklartStatCard label="Autobokförda" value={autoBookedTransactions ?? 0} description="Säkra träffar med aktiv regel." tone="success" />
        <NordklartStatCard label="Automatiseringsgrad" value={autoBookedTransactions ?? 0} description="Bokförda via säkra regler." />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl border bg-card p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Granskningskö</h2>
          <div className="mt-4 space-y-3">
            {((reviewItems ?? []) as ReviewItem[]).map((item) => (
              <div key={item.id} className="rounded-2xl border bg-background/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium">{item.title}</div>
                  <Badge variant={item.priority === 'urgent' || item.priority === 'high' ? 'warning' : 'secondary'}>{priorityLabel(item.priority)}</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{item.description ?? 'Ingen beskrivning'}</p>
                <div className="mt-2 text-xs text-muted-foreground">Säkerhet: {item.confidence ?? 'saknas'} · Status: {statusLabel(item.status)}</div>
              </div>
            ))}
            {(!reviewItems || reviewItems.length === 0) ? <p className="text-sm text-muted-foreground">Inga öppna ärenden.</p> : null}
          </div>
        </div>

        <div className="rounded-3xl border bg-card p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Automationsregler</h2>
          <div className="mt-4 space-y-3">
            {((rules ?? []) as RuleRow[]).map((rule) => (
              <div key={rule.id} className="rounded-2xl border bg-background/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium">{rule.name}</div>
                  <Badge variant={rule.status === 'active' ? 'success' : 'secondary'}>{statusLabel(rule.status)}</Badge>
                </div>
                <div className="mt-2 text-sm text-muted-foreground">{ruleTypeLabel(rule.rule_type)} · minsta säkerhet {rule.min_confidence}%</div>
                <div className="mt-1 text-xs text-muted-foreground">Autobokför: {rule.auto_book_allowed ? 'Ja' : 'Nej'} · Kräver granskning: {rule.requires_review ? 'Ja' : 'Nej'}</div>
              </div>
            ))}
            {(!rules || rules.length === 0) ? <p className="text-sm text-muted-foreground">Inga automationsregler ännu.</p> : null}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Skydd" title="Autobokföring kräver regel" description="En hög säkerhetsnivå räcker inte ensam. Regeln måste uttryckligen tillåta autobokföring och risknivån får inte vara hög." />
        <NordklartActionCard meta="Granskning" title="Osäkra transaktioner blir arbete" description="Okänd leverantör, flera möjliga matchningar eller momsosäkerhet hamnar i granskningskön." />
        <NordklartActionCard meta="Spårbarhet" title="Beslut kan förklaras" description="Beslutsorsaker, vald matchning, säkerhetsnivå och föreslaget konto sparas för spårbarhet." />
      </div>
    </NordklartPageShell>
  )
}
