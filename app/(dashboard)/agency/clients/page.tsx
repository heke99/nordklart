import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { agencyStatusTone, formatAgencyStatus, type AgencyClientOverview } from '@/lib/agency/dashboard'
import { NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function AgencyClientsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: rows } = await supabase
    .from('agency_client_overview_v')
    .select('*')
    .order('company_name', { ascending: true })

  const clients = (rows ?? []) as AgencyClientOverview[]
  const needsReview = clients.filter((c) => c.review_items_count > 0).length
  const bankNeedsAttention = clients.filter((c) => ['not_connected', 'needs_attention'].includes(c.bank_status)).length
  const overdue = clients.filter((c) => c.invoice_status === 'overdue' || c.supplier_invoice_status === 'overdue').length

  return (
    <NordklartPageShell
      eyebrow="Redovisningsbyrå"
      title="Byråkunder och status"
      description="Byrån ser kundbolag, ansvarig konsult, bankstatus, granskningskö, fakturastatus, bokslut, Bankgiro och nästa deadline utan att klientdata blandas mellan tenants."
      actions={<Button asChild variant="secondary"><Link href="/agency">Byråöversikt</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Klienter" value={clients.length} description="Kopplade byråkunder." tone="primary" />
        <NordklartStatCard label="Behöver granskning" value={needsReview} description="Klienter med öppna review items." tone="warning" />
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
              </tr>
            ))}
            {clients.length === 0 ? (
              <tr><td className="p-8 text-center text-muted-foreground" colSpan={7}>Inga byråkunder hittades för din behörighet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </NordklartPageShell>
  )
}
