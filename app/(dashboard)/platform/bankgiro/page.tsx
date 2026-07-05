import Link from 'next/link'
import { createServiceClient } from '@/lib/supabase/server'
import { requirePlatformRole } from '@/lib/auth/platform'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { reviewBankgiroApplicationAction } from './actions'

export const dynamic = 'force-dynamic'

type ApplicationRow = {
  id: string
  company_id: string
  status: string
  requested_product: string
  use_case: string | null
  submitted_at: string | null
  reviewed_at: string | null
  rejection_reason: string | null
  created_at: string
  companies: { name: string | null; org_number: string | null } | { name: string | null; org_number: string | null }[] | null
}

const STATUS_LABELS: Record<string, string> = {
  not_requested: 'Ej begärd',
  draft: 'Utkast',
  submitted: 'Inskickad',
  needs_information: 'Behöver kompletteras',
  under_review: 'Under granskning',
  approved: 'Godkänd',
  provider_setup: 'Provider-aktivering',
  active: 'Aktiv',
  rejected: 'Avslagen',
  suspended: 'Pausad',
}

const REVIEW_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'under_review', label: 'Ta till granskning' },
  { value: 'needs_information', label: 'Begär komplettering' },
  { value: 'approved', label: 'Godkänn' },
  { value: 'provider_setup', label: 'Provider-aktivering' },
  { value: 'active', label: 'Aktivera' },
  { value: 'rejected', label: 'Avslå' },
  { value: 'suspended', label: 'Pausa' },
]

function statusTone(status: string): 'success' | 'warning' | 'secondary' {
  if (status === 'active' || status === 'approved') return 'success'
  if (['submitted', 'needs_information', 'under_review', 'rejected', 'suspended'].includes(status)) return 'warning'
  return 'secondary'
}

function companyLabel(row: ApplicationRow): string {
  const company = Array.isArray(row.companies) ? row.companies[0] : row.companies
  return company?.name ?? 'Okänt bolag'
}

const date = (value: string | null) =>
  value ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium' }).format(new Date(value)) : '–'

export default async function PlatformBankgiroPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>
}) {
  // All platform roles may inspect; only superadmin gets review actions.
  const { role } = await requirePlatformRole()
  const canReview = role === 'platform_admin'
  const query = await searchParams

  // Cross-tenant stats require the service client — RLS-scoped reads return
  // zeros for platform_support / platform_auditor.
  const supabase = createServiceClient()

  const [providers, applications, review, active, mandates, reconciliation, { data: applicationRows }] = await Promise.all([
    supabase.from('payment_providers').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('bankgiro_applications').select('*', { count: 'exact', head: true }),
    supabase.from('bankgiro_applications').select('*', { count: 'exact', head: true }).in('status', ['submitted', 'needs_information', 'under_review']),
    supabase.from('bankgiro_applications').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('payment_mandates').select('*', { count: 'exact', head: true }).in('status', ['pending', 'active']),
    supabase.from('payment_reconciliation_items').select('*', { count: 'exact', head: true }).in('status', ['unmatched', 'needs_review']),
    supabase
      .from('bankgiro_applications')
      .select('id, company_id, status, requested_product, use_case, submitted_at, reviewed_at, rejection_reason, created_at, companies:company_id(name, org_number)')
      .not('status', 'in', '(not_requested)')
      .order('submitted_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(30),
  ])

  const rows = (applicationRows ?? []) as unknown as ApplicationRow[]

  return (
    <NordklartPageShell
      eyebrow="Bankgiro och Autogiro"
      title="Bankgiro/Autogiro provider-modul"
      description="Ansökningar, provider setup, dokument, ägarfrågor, mandat, collections och avstämning är separat från bokföringskärnan."
      actions={<Button asChild variant="secondary"><Link href="/platform">Till plattform</Link></Button>}
    >
      {query.notice ? <div className="rounded-2xl border border-success/30 bg-success/10 px-5 py-3 text-sm text-success">{query.notice}</div> : null}
      {query.error ? <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-3 text-sm text-destructive">{query.error}</div> : null}

      <div className="grid gap-4 md:grid-cols-6">
        <NordklartStatCard label="Providers" value={providers.count ?? 0} description="GoCardless/Leslie/fil/future." />
        <NordklartStatCard label="Ansökningar" value={applications.count ?? 0} description="Alla tenants." />
        <NordklartStatCard label="Review" value={review.count ?? 0} description="Behöver åtgärd." tone={(review.count ?? 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Aktiva" value={active.count ?? 0} description="status=active." tone="success" />
        <NordklartStatCard label="Mandat" value={mandates.count ?? 0} description="Pending/active." />
        <NordklartStatCard label="Avstämning" value={reconciliation.count ?? 0} description="Unmatched/needs review." tone={(reconciliation.count ?? 0) > 0 ? 'warning' : 'success'} />
      </div>

      <div className="overflow-hidden rounded-3xl border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-3">
          <h2 className="text-lg font-semibold">Ansökningar</h2>
          <span className="text-sm text-muted-foreground">{canReview ? 'Granska och besluta nedan.' : 'Läsläge — beslut kräver superadmin.'}</span>
        </div>
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-3">Bolag</th>
              <th className="p-3">Status</th>
              <th className="p-3">Inskickad</th>
              <th className="p-3">Granskad</th>
              {canReview ? <th className="p-3">Beslut</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t align-top">
                <td className="p-3">
                  <div className="font-medium">{companyLabel(row)}</div>
                  <div className="text-xs text-muted-foreground">{row.use_case ?? row.requested_product}</div>
                </td>
                <td className="p-3">
                  <Badge variant={statusTone(row.status)}>{STATUS_LABELS[row.status] ?? row.status}</Badge>
                  {row.rejection_reason ? <p className="mt-1 max-w-56 text-xs text-muted-foreground">{row.rejection_reason}</p> : null}
                </td>
                <td className="p-3 text-muted-foreground">{date(row.submitted_at)}</td>
                <td className="p-3 text-muted-foreground">{date(row.reviewed_at)}</td>
                {canReview ? (
                  <td className="p-3">
                    <form action={reviewBankgiroApplicationAction} className="flex flex-col gap-2">
                      <input type="hidden" name="application_id" value={row.id} />
                      <select name="next_status" className="h-9 rounded-lg border bg-card px-2 text-sm" defaultValue="under_review">
                        {REVIEW_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                      <input
                        name="note"
                        placeholder="Motivering (krävs vid avslag)"
                        className="h-9 rounded-lg border bg-card px-2 text-sm"
                      />
                      <Button type="submit" size="sm" variant="secondary">Uppdatera</Button>
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr><td className="p-8 text-center text-muted-foreground" colSpan={canReview ? 5 : 4}>Inga ansökningar ännu.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Princip" title="Inte krav för vanlig bokföring" description="Bankgiroflödet är separat från bokföring direkt och bankautomation." />
        <NordklartActionCard meta="Providers" title="Adaptermodell" description="payment_providers bär adapter_key, capabilities och setup_requirements för framtida partnerbyte." />
        <NordklartActionCard meta="Kundvy" title="Ansökan och status" description="Tenant-admin kan se sitt flöde och starta onboarding.">
          <Button asChild size="sm"><Link href="/payments/bankgiro">Öppna kundvy</Link></Button>
        </NordklartActionCard>
      </div>
    </NordklartPageShell>
  )
}
