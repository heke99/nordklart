import { requirePlatformRole } from '@/lib/auth/platform'
import {
  computeIntegrationReadiness,
  READINESS_STATUS_LABELS_SV,
  type IntegrationReadinessStatus,
} from '@/lib/platform/integration-readiness'
import { NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<IntegrationReadinessStatus, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  production_ready: 'success',
  sandbox_ready: 'default',
  requires_agreement: 'warning',
  not_configured: 'secondary',
  misconfigured: 'destructive',
  blocked: 'destructive',
}

const RESPONSIBLE_LABELS: Record<string, string> = {
  superadmin: 'Superadmin',
  company: 'Företaget',
  agency: 'Byrån',
}

/**
 * /platform/integrations — go-live readiness per integration.
 *
 * Computed live from environment configuration (no DB state) so the page
 * always reflects the running deployment. requires_agreement means the code
 * is ready but an external agreement/certificate must be signed first.
 */
export default async function PlatformIntegrationsPage() {
  await requirePlatformRole()

  const entries = computeIntegrationReadiness()
  const productionReady = entries.filter((e) => e.status === 'production_ready').length
  const sandboxReady = entries.filter((e) => e.status === 'sandbox_ready').length
  const requiresAgreement = entries.filter((e) => e.status === 'requires_agreement').length
  const problems = entries.filter((e) => e.status === 'misconfigured' || e.status === 'blocked').length

  return (
    <NordklartPageShell
      eyebrow="Go-live-status"
      title="Integrationer"
      description="Status per integration i den här driftsättningen: produktionsklar, sandbox-klar, kräver externt avtal, ej konfigurerad eller felkonfigurerad. Beräknas direkt från miljökonfigurationen."
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Produktionsklara" value={productionReady} description="Full produktionskonfiguration." tone="success" />
        <NordklartStatCard label="Sandbox-klara" value={sandboxReady} description="Testläge fungerar hela vägen." tone="primary" />
        <NordklartStatCard label="Kräver avtal" value={requiresAgreement} description="Tekniskt förberedda — externt avtal saknas." tone="warning" />
        <NordklartStatCard label="Problem" value={problems} description="Felkonfigurerade eller blockerade." tone={problems > 0 ? 'warning' : 'success'} />
      </div>

      <div className="rounded-3xl border bg-card p-5 shadow-sm">
        <h2 className="text-xl font-semibold">Alla integrationer</h2>
        <div className="mt-4 space-y-3">
          {entries.map((entry) => (
            <div key={entry.id} className="flex flex-col gap-2 rounded-2xl border bg-background/70 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{entry.name}</span>
                  <Badge variant={STATUS_VARIANT[entry.status]}>
                    {READINESS_STATUS_LABELS_SV[entry.status]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    Ansvarig: {RESPONSIBLE_LABELS[entry.responsible]}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{entry.message_sv}</p>
                {entry.missingEnvVars.length > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Saknade variabler: <code className="text-xs">{entry.missingEnvVars.join(', ')}</code>
                  </p>
                ) : null}
              </div>
              {entry.docsPath ? (
                <Link href={entry.docsPath} className="shrink-0 text-sm text-primary underline-offset-4 hover:underline">
                  Öppna
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </NordklartPageShell>
  )
}
