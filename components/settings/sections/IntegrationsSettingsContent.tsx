'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate } from '@/lib/utils'
import { Banknote, Building2, FileText, KeyRound, Landmark, Send, ShieldCheck, Webhook } from 'lucide-react'

interface BankConnectionRow {
  id: string
  bank_name: string | null
  status: string
  consent_status: string | null
  sync_status: string | null
  last_synced_at: string | null
  consent_expires: string | null
}

interface IntegrationsStatus {
  bank: {
    connections: BankConnectionRow[]
    latest_sync: { started_at: string; status: string } | null
  }
  skatteverket: { connection_status: string; token_status: string }
  bankgiro: { status: string; provider_setup_status: string | null } | null
  peppol: { readiness: string; delivery_count: number }
  invoice_financing: { readiness: string }
  bankid: { active_consents: number }
  api: { active_keys: number }
  webhooks: { active: number; failed_deliveries: number }
}

function StatusBadge({ tone, children }: { tone: 'ok' | 'warn' | 'off'; children: React.ReactNode }) {
  const variant = tone === 'ok' ? 'success' : tone === 'warn' ? 'warning' : 'secondary'
  return <Badge variant={variant as 'default'}>{children}</Badge>
}

/**
 * Settings → Integrationer: company-facing status per integration with links
 * to the management surfaces. Read-only aggregate (GET /api/integrations/status).
 */
export function IntegrationsSettingsContent() {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/integrations/status')
        const json = await res.json().catch(() => null)
        if (!cancelled && res.ok && json?.data) setStatus(json.data as IntegrationsStatus)
      } catch {
        // Leave skeleton — non-fatal.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!status) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  const activeBank = status.bank.connections.filter((c) => c.status === 'active')
  const bankTone = activeBank.length > 0 ? 'ok' : 'off'
  const skvConnected = status.skatteverket.connection_status === 'connected'

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Landmark className="h-4 w-4" /> Bankkoppling (PSD2)</CardTitle>
          <CardDescription>Automatisk hämtning av banktransaktioner via Enable Banking eller manuell filimport.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={bankTone}>{activeBank.length > 0 ? `${activeBank.length} aktiv koppling` : 'Ingen aktiv koppling'}</StatusBadge>
            {status.bank.latest_sync ? (
              <span className="text-sm text-muted-foreground">
                Senaste synk: {formatDate(status.bank.latest_sync.started_at)} ({status.bank.latest_sync.status})
              </span>
            ) : null}
          </div>
          {status.bank.connections.slice(0, 3).map((conn) => (
            <p key={conn.id} className="text-sm text-muted-foreground">
              {conn.bank_name ?? 'Bank'}: {conn.status}
              {conn.consent_status && conn.consent_status !== 'active' ? ` — samtycke: ${conn.consent_status}` : ''}
            </p>
          ))}
          <Link href="/settings/banking" className="text-sm text-primary underline-offset-4 hover:underline">Hantera bankkoppling</Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Building2 className="h-4 w-4" /> Skatteverket</CardTitle>
          <CardDescription>Moms- och arbetsgivardeklarationer förbereds här — signering sker alltid på Skatteverkets Mina sidor.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <StatusBadge tone={skvConnected ? 'ok' : 'off'}>
            {skvConnected ? 'Ansluten' : status.skatteverket.connection_status === 'needs_reauth' ? 'Behöver återanslutas' : 'Inte ansluten'}
          </StatusBadge>
          <div>
            <Link href="/skatteverket" className="text-sm text-primary underline-offset-4 hover:underline">Öppna Skatteverket-panelen</Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Banknote className="h-4 w-4" /> Bankgiro</CardTitle>
          <CardDescription>Bankgironummer och Autogiro tecknas via din bank — Nordklart förbereder ansökan och hanterar filerna.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <StatusBadge tone={status.bankgiro && status.bankgiro.status !== 'not_requested' ? 'ok' : 'off'}>
            {status.bankgiro ? status.bankgiro.status : 'Ingen ansökan'}
          </StatusBadge>
          <div>
            <Link href="/bankgiro" className="text-sm text-primary underline-offset-4 hover:underline">Hantera Bankgiro</Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Send className="h-4 w-4" /> Peppol e-faktura</CardTitle>
          <CardDescription>E-fakturor via Peppol-nätverket. Produktion kräver avtal med en accesspunkt — PDF/e-post fungerar alltid.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={status.peppol.readiness === 'sandbox_ready' ? 'warn' : 'off'}>
              {status.peppol.readiness === 'sandbox_ready' ? 'Testläge' : 'Kräver avtal med accesspunkt'}
            </StatusBadge>
            <span className="text-sm text-muted-foreground">{status.peppol.delivery_count} leveranser</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileText className="h-4 w-4" /> Fakturafinansiering</CardTitle>
          <CardDescription>Sälj eller belåna skickade kundfakturor. Produktion kräver avtal med en finansieringspartner.</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusBadge tone={status.invoice_financing.readiness === 'sandbox_ready' ? 'warn' : 'off'}>
            {status.invoice_financing.readiness === 'sandbox_ready' ? 'Testläge' : 'Kräver avtal'}
          </StatusBadge>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" /> BankID</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-semibold">{status.bankid.active_consents}</p>
            <p className="text-xs text-muted-foreground">aktiva samtycken</p>
            <Link href="/settings/bankid" className="text-sm text-primary underline-offset-4 hover:underline">Hantera</Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" /> API-nycklar</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-semibold">{status.api.active_keys}</p>
            <p className="text-xs text-muted-foreground">aktiva nycklar</p>
            <Link href="/settings/api" className="text-sm text-primary underline-offset-4 hover:underline">Hantera</Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Webhook className="h-4 w-4" /> Webhooks</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-2xl font-semibold">{status.webhooks.active}</p>
            <p className="text-xs text-muted-foreground">
              aktiva mottagare{status.webhooks.failed_deliveries > 0 ? ` — ${status.webhooks.failed_deliveries} misslyckade leveranser` : ''}
            </p>
            <Link href="/settings/webhooks" className="text-sm text-primary underline-offset-4 hover:underline">Hantera</Link>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
