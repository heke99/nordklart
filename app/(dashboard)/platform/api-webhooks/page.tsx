import Link from 'next/link'
import { requirePlatformRole } from '@/lib/auth/platform'
import { createServiceClient } from '@/lib/supabase/server'
import { NORDKLART_WEBHOOK_EVENTS } from '@/lib/api/webhook-catalog'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function PlatformApiWebhooksPage() {
  await requirePlatformRole()
  const supabase = createServiceClient()

  const [clients, webhooks, deliveries, failedDeliveries, events] = await Promise.all([
    supabase.from('api_clients').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('webhooks').select('*', { count: 'exact', head: true }).eq('active', true).is('disabled_at', null),
    supabase.from('webhook_deliveries').select('*', { count: 'exact', head: true }),
    supabase.from('webhook_deliveries').select('*', { count: 'exact', head: true }).in('status', ['failed', 'dead']).gte('attempts', 3),
    supabase.from('webhook_events').select('*', { count: 'exact', head: true }).eq('status', 'active'),
  ])

  return (
    <NordklartPageShell
      eyebrow="API och webhooks"
      title="API & Webhooks"
      description="API-klienter, scopes, eventkatalog, signing, retries och leveransloggar läser samma webhook-modell som leveransmotorn använder."
      actions={<Button asChild variant="secondary"><Link href="/api/v1/openapi.json">OpenAPI</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-5">
        <NordklartStatCard label="API-klienter" value={clients.count ?? 0} description="Aktiva." />
        <NordklartStatCard label="Webhooks" value={webhooks.count ?? 0} description="Aktiva mottagare." tone="primary" />
        <NordklartStatCard label="Leveranser" value={deliveries.count ?? 0} description="Leveransloggar." />
        <NordklartStatCard label="Retries/fel" value={failedDeliveries.count ?? 0} description="Misslyckade eller döda leveranser." tone={(failedDeliveries.count ?? 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Eventkatalog" value={events.count ?? NORDKLART_WEBHOOK_EVENTS.length} description="Aktiva events." />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Scopes" title="Domäner" description="year_end, tax, bankgiro och webhook-events har egna read/write-scopes i v1." />
        <NordklartActionCard meta="Signing" title="Webhook-signatur och retries" description="Leveranser signeras med mottagarens hemlighet och kör kontrollerade försök med backoff." />
        <NordklartActionCard meta="Docs" title="OpenAPI och katalog" description="Endpoints registreras i v1-registry så dokumentation och scopekrav hänger ihop." />
      </div>
    </NordklartPageShell>
  )
}
