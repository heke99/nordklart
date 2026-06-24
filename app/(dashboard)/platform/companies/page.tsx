import Link from 'next/link'
import { Building2, Filter, Search, ShieldCheck } from 'lucide-react'
import { requirePlatformRole } from '@/lib/auth/platform'
import { NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  accessStatusLabel,
  asString,
  bankgiroStatusLabel,
  companyKindLabel,
  entityTypeLabel,
  listPlatformCompanies,
} from '@/lib/platform/company-overview'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

const fmtDate = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('sv-SE', { dateStyle: 'medium' }).format(new Date(value)) : '–'

function statusVariant(status: string | null | undefined): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (status === 'active') return 'success'
  if (status === 'missing' || status === 'past_due') return 'warning'
  if (status === 'cancelled' || status === 'expired') return 'destructive'
  return 'secondary'
}

export default async function PlatformCompaniesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePlatformRole()
  const params = await searchParams
  const filters = {
    q: asString(params.q),
    kind: asString(params.kind) || 'all',
    entityType: asString(params.entityType) || 'all',
    accessStatus: asString(params.accessStatus) || 'all',
    planCode: asString(params.planCode) || 'all',
    bankgiroStatus: asString(params.bankgiroStatus) || 'all',
    accountingStatus: asString(params.accountingStatus) || 'all',
  }
  const { rows, count, kpis, planOptions } = await listPlatformCompanies(filters)

  return (
    <NordklartPageShell
      eyebrow="Superadmin · bolag"
      title="Bolag, byråer och åtkomst"
      description="Sök, filtrera och granska alla bolag i Nordklart. Härifrån öppnar du bolagskortet för användare, abonnemang, Bankgiro, bokslut och bokföringskontroller."
      actions={<Button asChild variant="secondary"><Link href="/platform">Till plattform</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-5">
        <NordklartStatCard label="Totalt" value={kpis.totalCompanies} description="Alla bolag" />
        <NordklartStatCard label="AB" value={kpis.limitedCompanies} description="Aktiebolag" />
        <NordklartStatCard label="Enskilda firmor" value={kpis.soleTraders} description="Registrerade firmor" />
        <NordklartStatCard label="Byråer" value={kpis.agencies} description="Byråarbetsytor" tone="primary" />
        <NordklartStatCard label="Byråkunder" value={kpis.agencyClients} description="Kundbolag kopplade till byrå" />
      </div>
      <div className="grid gap-4 md:grid-cols-5">
        <NordklartStatCard label="Aktiv åtkomst" value={kpis.activeAccess} description="Plan eller giltig åtkomst" tone="success" />
        <NordklartStatCard label="Saknar plan" value={kpis.missingAccess} description="Behöver åtgärd" tone={kpis.missingAccess > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Bankgiro" value={kpis.bankgiroReview} description="Ansökningar att granska" tone={kpis.bankgiroReview > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Bokföringskontroll" value={kpis.accountingIssues} description="Bolag med öppna kontrollpunkter" tone={kpis.accountingIssues > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Visar" value={count} description="Matchar filtren" />
      </div>

      <section className="rounded-3xl border bg-card p-5 shadow-sm">
        <form className="grid gap-3 md:grid-cols-[1.5fr_repeat(6,1fr)_auto]" action="/platform/companies">
          <label className="text-sm font-medium">
            Sök
            <div className="mt-1 flex h-10 items-center gap-2 rounded-lg border bg-background px-3">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input name="q" defaultValue={filters.q ?? ''} placeholder="Bolag, org.nr" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            </div>
          </label>
          <SelectFilter label="Typ" name="kind" value={filters.kind} options={[
            ['all', 'Alla'], ['company', 'Företag'], ['agency', 'Byrå'], ['agency_client', 'Byråkund'],
          ]} />
          <SelectFilter label="Bolagsform" name="entityType" value={filters.entityType} options={[
            ['all', 'Alla'], ['aktiebolag', 'AB'], ['enskild_firma', 'EF'],
          ]} />
          <SelectFilter label="Åtkomst" name="accessStatus" value={filters.accessStatus} options={[
            ['all', 'Alla'], ['active', 'Aktiv'], ['missing', 'Saknar'], ['past_due', 'Betalning'], ['paused', 'Pausad'], ['cancelled', 'Avslutad'],
          ]} />
          <SelectFilter label="Plan" name="planCode" value={filters.planCode} options={[[ 'all', 'Alla' ], ...planOptions.map((plan) => [plan.code, plan.name] as [string, string])]} />
          <SelectFilter label="Bankgiro" name="bankgiroStatus" value={filters.bankgiroStatus} options={[
            ['all', 'Alla'], ['submitted', 'Inskickad'], ['needs_information', 'Komplettering'], ['under_review', 'Granskning'], ['active', 'Aktiv'], ['rejected', 'Nekad'],
          ]} />
          <SelectFilter label="Bokföring" name="accountingStatus" value={filters.accountingStatus} options={[
            ['all', 'Alla'], ['issues', 'Kontrollpunkter'],
          ]} />
          <div className="flex items-end">
            <Button type="submit" className="w-full"><Filter className="mr-2 h-4 w-4" />Filtrera</Button>
          </div>
        </form>
      </section>

      <section className="grid gap-4">
        {rows.map((company) => {
          const accountingIssues = (company.unlinked_document_count || 0) + (company.pending_inbox_count || 0) + (company.unbooked_transaction_count || 0)
          return (
            <Link key={company.id} href={`/platform/companies/${company.id}`} className="group rounded-3xl border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Building2 className="h-5 w-5 text-primary" />
                    <h2 className="truncate text-xl font-semibold group-hover:text-primary">{company.name}</h2>
                    <Badge variant="secondary">{companyKindLabel(company.workspace_kind)}</Badge>
                    <Badge variant="outline">{entityTypeLabel(company.entity_type)}</Badge>
                    <Badge variant={statusVariant(company.access_status)}>{accessStatusLabel(company.access_status)}</Badge>
                    {accountingIssues > 0 ? <Badge variant="warning">{accountingIssues} kontrollpunkter</Badge> : <Badge variant="success">Bokföring OK</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {company.org_number || 'Org.nr saknas'} · {company.member_count} användare · skapad {fmtDate(company.created_at)}
                  </p>
                  <div className="grid gap-2 text-sm text-muted-foreground md:grid-cols-4">
                    <div><span className="font-medium text-foreground">Plan:</span> {company.plan_name || 'Ingen plan'}</div>
                    <div><span className="font-medium text-foreground">Byrå:</span> {company.agency_name || company.client_agency_name || 'Ej kopplad'}</div>
                    <div><span className="font-medium text-foreground">Bankgiro:</span> {bankgiroStatusLabel(company.bankgiro_status)}</div>
                    <div><span className="font-medium text-foreground">Senaste verifikation:</span> {fmtDate(company.last_journal_entry_at)}</div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                  <ShieldCheck className="h-4 w-4" /> Öppna bolagskort
                </div>
              </div>
            </Link>
          )
        })}
        {rows.length === 0 ? (
          <div className="rounded-3xl border bg-card p-10 text-center text-muted-foreground">
            Inga bolag matchar filtren.
          </div>
        ) : null}
      </section>
    </NordklartPageShell>
  )
}

function SelectFilter({ label, name, value, options }: { label: string; name: string; value: string | null | undefined; options: Array<[string, string]> }) {
  return (
    <label className="text-sm font-medium">
      {label}
      <select name={name} defaultValue={value ?? 'all'} className="mt-1 h-10 w-full rounded-lg border bg-background px-3 text-sm">
        {options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}
      </select>
    </label>
  )
}
