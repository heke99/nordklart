import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { listAccessibleCompanies } from '@/lib/access/company'
import { AGENCY_ADMIN_ROLES } from '@/lib/agency/commercial'
import { agencyStatusTone, formatAgencyStatus, type AgencyClientOverview } from '@/lib/agency/dashboard'
import { AddClientDialog, type LinkableCompany } from '@/components/agency/AddClientDialog'
import { OpenClientWorkspaceButton } from '@/components/agency/OpenClientWorkspaceButton'
import { NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function AgencyClientsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: rows }, { data: adminMembership }, accessibleCompanies] = await Promise.all([
    supabase
      .from('agency_client_overview_v')
      .select('*')
      .order('company_name', { ascending: true }),
    supabase
      .from('agency_members')
      .select('agency_id, role, agencies:agency_id(company_id)')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .in('role', [...AGENCY_ADMIN_ROLES])
      .limit(1)
      .maybeSingle(),
    listAccessibleCompanies(supabase),
  ])

  const clients = (rows ?? []) as AgencyClientOverview[]
  const needsReview = clients.filter((c) => c.review_items_count > 0).length
  const bankNeedsAttention = clients.filter((c) => ['not_connected', 'needs_attention'].includes(c.bank_status)).length
  const overdue = clients.filter((c) => c.invoice_status === 'overdue' || c.supplier_invoice_status === 'overdue').length

  const isAgencyAdmin = Boolean(adminMembership)
  const agencyRelation = Array.isArray(adminMembership?.agencies)
    ? adminMembership?.agencies[0]
    : adminMembership?.agencies
  const agencyOwnCompanyId = agencyRelation?.company_id ?? null
  const linkedCompanyIds = new Set(clients.map((c) => c.company_id))

  // Companies the user can link directly: directly administered workspaces
  // that are not already agency clients and not the agency's own
  // subscription company. Foreign companies require client-side approval.
  const linkableCompanies: LinkableCompany[] = accessibleCompanies
    .filter(
      (company) =>
        company.accessSource === 'direct' &&
        company.canManageCompany &&
        !company.archivedAt &&
        !linkedCompanyIds.has(company.companyId) &&
        company.companyId !== agencyOwnCompanyId,
    )
    .map((company) => ({
      id: company.companyId,
      name: company.name,
      orgNumber: company.orgNumber,
    }))

  return (
    <NordklartPageShell
      eyebrow="Redovisningsbyrå"
      title="Kundbolag och status"
      description="Byrån ser kundbolag, ansvarig konsult, bankstatus, granskningskö, fakturastatus, bokslut, Bankgiro och nästa deadline på ett ställe."
      actions={
        <div className="flex flex-wrap gap-2">
          {isAgencyAdmin ? (
            <AddClientDialog
              agencyId={adminMembership?.agency_id}
              linkableCompanies={linkableCompanies}
            />
          ) : null}
          <Button asChild variant="secondary"><Link href="/agency">Byråöversikt</Link></Button>
        </div>
      }
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Kunder" value={clients.length} description="Kopplade kundbolag." tone="primary" />
        <NordklartStatCard label="Behöver granskning" value={needsReview} description="Kunder med öppna granskningspunkter." tone="warning" />
        <NordklartStatCard label="Bank åtgärd" value={bankNeedsAttention} description="Saknad/avvikande bankkoppling." />
        <NordklartStatCard label="Försenat" value={overdue} description="Kund- eller leverantörsfakturor." tone={overdue > 0 ? 'warning' : 'success'} />
      </div>

      <div className="overflow-hidden rounded-3xl border bg-card shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-3">Kund</th>
              <th className="p-3">Ansvarig</th>
              <th className="p-3">Bank</th>
              <th className="p-3">Granska</th>
              <th className="p-3">Moms</th>
              <th className="p-3">Bokslut</th>
              <th className="p-3">Nästa deadline</th>
              <th className="p-3"><span className="sr-only">Åtgärder</span></th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={`${client.agency_id}-${client.company_id}`} className="border-t align-top">
                <td className="p-3">
                  <div className="font-medium">{client.company_name}</div>
                  <div className="text-xs text-muted-foreground">{client.org_number ?? 'Org.nr saknas'}</div>
                </td>
                <td className="p-3 text-muted-foreground">{client.primary_accountant_name ?? 'Ej tilldelad'}</td>
                <td className="p-3"><Badge variant={agencyStatusTone(client.bank_status)}>{formatAgencyStatus(client.bank_status)}</Badge></td>
                <td className="p-3 tabular-nums">{client.review_items_count}</td>
                <td className="p-3"><Badge variant={agencyStatusTone(client.vat_status)}>{formatAgencyStatus(client.vat_status)}</Badge></td>
                <td className="p-3"><Badge variant={agencyStatusTone(client.year_end_status)}>{formatAgencyStatus(client.year_end_status)}</Badge></td>
                <td className="p-3 text-muted-foreground">{client.next_deadline_at ?? 'Ingen'}</td>
                <td className="p-3 text-right">
                  <OpenClientWorkspaceButton companyId={client.company_id} />
                </td>
              </tr>
            ))}
            {clients.length === 0 ? (
              <tr><td className="p-8 text-center text-muted-foreground" colSpan={8}>Inga byråkunder hittades för din behörighet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </NordklartPageShell>
  )
}
