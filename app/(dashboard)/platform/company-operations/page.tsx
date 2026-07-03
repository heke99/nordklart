import Link from 'next/link'
import { requirePlatformRole } from '@/lib/auth/platform'
import { createServiceClient } from '@/lib/supabase/server'
import { NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { formatDate } from '@/lib/utils'

export const dynamic = 'force-dynamic'

interface OperationalRow {
  company_id: string
  onboarding_status: string | null
  open_review_count: number
  journal_entry_count: number
  last_journal_entry_at: string | null
  unlinked_document_count: number
  pending_inbox_count: number
  unbooked_transaction_count: number
}

/**
 * /platform/company-operations — cross-company operations console.
 *
 * Ranks companies by operational backlog (open review items, unbooked
 * transactions, pending inbox documents, stale bookkeeping) so support can
 * see where users are stuck. Reads platform_company_operational_status_v.
 */
export default async function PlatformCompanyOperationsPage() {
  await requirePlatformRole()
  const supabase = createServiceClient()

  const [{ data: statusRows }, { data: companies }] = await Promise.all([
    supabase.from('platform_company_operational_status_v').select('*'),
    supabase.from('companies').select('id, name, org_number').is('archived_at', null),
  ])

  const nameById = new Map((companies ?? []).map((c) => [c.id as string, c as { id: string; name: string; org_number: string | null }]))

  const rows = ((statusRows ?? []) as OperationalRow[])
    .filter((row) => nameById.has(row.company_id))
    .map((row) => ({
      ...row,
      backlog:
        (row.open_review_count ?? 0) +
        (row.unbooked_transaction_count ?? 0) +
        (row.pending_inbox_count ?? 0),
    }))
    .toSorted((a, b) => b.backlog - a.backlog)

  const totalBacklog = rows.reduce((sum, row) => sum + row.backlog, 0)
  const companiesWithBacklog = rows.filter((row) => row.backlog > 0).length
  const staleCutoffMs = new Date().getTime() - 45 * 86_400_000
  const staleCompanies = rows.filter(
    (row) =>
      row.journal_entry_count > 0 &&
      row.last_journal_entry_at &&
      new Date(row.last_journal_entry_at).getTime() < staleCutoffMs,
  ).length

  return (
    <NordklartPageShell
      eyebrow="Driftkonsol"
      title="Företagsoperationer"
      description="Företag rangordnade efter operativ eftersläpning: öppna granskningsärenden, obokade transaktioner och väntande inkorgsdokument. Använd konsolen för att se var kunder fastnat."
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Företag" value={rows.length} description="Aktiva (ej arkiverade)." />
        <NordklartStatCard label="Med eftersläpning" value={companiesWithBacklog} description="Företag med öppna ärenden." tone={companiesWithBacklog > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Total eftersläpning" value={totalBacklog} description="Granskningar + obokat + inkorg." />
        <NordklartStatCard label="Inaktiva > 45 dagar" value={staleCompanies} description="Har bokfört tidigare men inte nyligen." tone={staleCompanies > 0 ? 'warning' : 'success'} />
      </div>

      <div className="rounded-3xl border bg-card p-5 shadow-sm">
        <h2 className="text-xl font-semibold">Företag efter eftersläpning</h2>
        <div className="mt-4 space-y-2">
          {rows.slice(0, 50).map((row) => {
            const company = nameById.get(row.company_id)!
            return (
              <Link
                key={row.company_id}
                href={`/platform/companies/${row.company_id}`}
                className="flex flex-col gap-1 rounded-2xl border bg-background/70 p-4 transition-colors hover:bg-accent/50 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <span className="font-medium">{company.name}</span>
                  {company.org_number ? (
                    <span className="ml-2 text-xs text-muted-foreground">{company.org_number}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  <span>Granska: {row.open_review_count ?? 0}</span>
                  <span>Obokat: {row.unbooked_transaction_count ?? 0}</span>
                  <span>Inkorg: {row.pending_inbox_count ?? 0}</span>
                  <span>
                    Senaste verifikation:{' '}
                    {row.last_journal_entry_at ? formatDate(row.last_journal_entry_at) : 'aldrig'}
                  </span>
                </div>
              </Link>
            )
          })}
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Inga företag att visa.</p>
          ) : null}
        </div>
      </div>
    </NordklartPageShell>
  )
}
