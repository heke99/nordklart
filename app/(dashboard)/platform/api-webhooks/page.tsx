import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { NORDKLART_WEBHOOK_EVENTS } from '@/lib/api/webhook-catalog'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function PlatformApiWebhooksPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [clients, endpoints, deliveries, failedDeliveries, events] = await Promise.all([
    supabase.from('api_clients').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('webhook_endpoints').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('webhook_deliveries').select('*', { count: 'exact', head: true }),
    supabase.from('webhook_deliveries').select('*', { count: 'exact', head: true }).gte('attempts', 3),
    supabase.from('webhook_events').select('*', { count: 'exact', head: true }).eq('status', 'active'),
  ])

  return (
    <NordklartPageShell
      eyebrow="Platform · Batch 11"
      title="API & Webhooks"
      description="API-klienter, scopes, eventkatalog, signing, retries och leveransloggar kopplas till tenant-scope och v1-dokumentationen."
      actions={<Button asChild variant="secondary"><Link href="/api/v1/openapi.json">OpenAPI</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-5">
        <NordklartStatCard label="API-klienter" value={clients.count ?? 0} description="Aktiva." />
        <NordklartStatCard label="Webhook endpoints" value={endpoints.count ?? 0} description="Aktiva." tone="primary" />
        <NordklartStatCard label="Deliveries" value={deliveries.count ?? 0} description="Leveransloggar." />
        <NordklartStatCard label="Retries/fel" value={failedDeliveries.count ?? 0} description="attempts >= 3." tone={(failedDeliveries.count ?? 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Eventkatalog" value={events.count ?? NORDKLART_WEBHOOK_EVENTS.length} description="Aktiva events." />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Scopes" title="Nya domäner" description="year_end, tax, bankgiro och webhook_events har egna read/write-scopes i v1." />
        <NordklartActionCard meta="Signing" title="Webhook-signatur och retries" description="webhook_deliveries har request_id, signature, response_status och next_retry_at." />
        <NordklartActionCard meta="Docs" title="OpenAPI och katalog" description="Nya endpoints registreras i v1-registry så dokumentation och scopekrav hänger ihop." />
      </div>
    </NordklartPageShell>
  )
}
