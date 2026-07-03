'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { formatDate } from '@/lib/utils'
import { Webhook as WebhookIcon, Copy } from 'lucide-react'

interface WebhookRow {
  id: string
  name: string
  event_type: string
  webhook_url: string
  active: boolean
  disabled_at: string | null
  disabled_reason: string | null
  created_at: string
}

interface DeliveryRow {
  id: string
  webhook_id: string | null
  event_type: string
  status: 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dead'
  attempts: number
  response_status: number | null
  error: string | null
  created_at: string
}

interface CatalogEntry {
  type: string
  delivered: boolean
  description: string
}

const DELIVERY_BADGE: Record<DeliveryRow['status'], 'success' | 'secondary' | 'warning' | 'destructive'> = {
  delivered: 'success',
  pending: 'secondary',
  in_flight: 'secondary',
  failed: 'warning',
  dead: 'destructive',
}

/**
 * Settings → Webhooks: register endpoints, monitor deliveries, redeliver
 * failed ones. Mirrors the v1 API surface (same catalog, same SSRF guard).
 */
export function WebhooksSettingsContent() {
  const { toast } = useToast()
  const [webhooks, setWebhooks] = useState<WebhookRow[] | null>(null)
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([])
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [name, setName] = useState('')
  const [eventType, setEventType] = useState('')
  const [url, setUrl] = useState('')
  const [creating, setCreating] = useState(false)
  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/webhooks/manage')
      const json = await res.json()
      if (res.ok) {
        setWebhooks(json.data.webhooks ?? [])
        setDeliveries(json.data.deliveries ?? [])
        setCatalog(json.data.catalog ?? [])
      } else {
        setWebhooks([])
      }
    } catch {
      setWebhooks([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  async function handleCreate() {
    setCreating(true)
    setNewSecret(null)
    try {
      const res = await fetch('/api/webhooks/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, event_type: eventType, webhook_url: url }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte skapa webhooken',
          description: json?.error?.message || json?.error || '',
          variant: 'destructive',
        })
        return
      }
      setNewSecret(json.data.secret)
      setName('')
      setUrl('')
      setEventType('')
      toast({ title: 'Webhook skapad', description: 'Kopiera signeringsnyckeln — den visas bara en gång.' })
      await reload()
    } catch {
      toast({ title: 'Kunde inte skapa webhooken', variant: 'destructive' })
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/webhooks/manage/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const json = await res.json()
        toast({ title: 'Kunde inte ta bort webhooken', description: json?.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Webhook borttagen' })
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  async function handleRedeliver(id: string) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/webhooks/manage/deliveries/${id}/redeliver`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Kunde inte skicka om leveransen', description: json?.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Leveransen har lagts i kö igen' })
      await reload()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Webhooks
        </h2>
        <p className="text-sm text-muted-foreground">
          Webhooks skickar händelser (fakturor, betalningar, bokföring,
          deklarationer) till din server i realtid. Varje leverans signeras
          med HMAC-SHA256 — verifiera signaturen med nyckeln du får när
          webhooken skapas. Se{' '}
          <a href="/docs/api/webhooks" className="text-primary underline">
            API-dokumentationen
          </a>{' '}
          för payload-format och verifieringsexempel.
        </p>

        {/* Create */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <WebhookIcon className="h-4 w-4" />
              Ny webhook
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="wh-name">Namn</Label>
                <Input id="wh-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="t.ex. ERP-synk" />
              </div>
              <div className="space-y-2">
                <Label>Händelse</Label>
                <Select value={eventType} onValueChange={setEventType}>
                  <SelectTrigger>
                    <SelectValue placeholder="Välj händelse" />
                  </SelectTrigger>
                  <SelectContent>
                    {catalog.map((e) => (
                      <SelectItem key={e.type} value={e.type}>
                        {e.type}{e.delivered ? '' : ' (planerad)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="wh-url">Mottagar-URL (https)</Label>
                <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhooks/nordklart" />
              </div>
            </div>
            <Button
              onClick={handleCreate}
              disabled={creating || !name.trim() || !eventType || !url.trim()}
            >
              {creating ? 'Skapar…' : 'Skapa webhook'}
            </Button>
            {newSecret && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <p className="mb-1 font-medium">Signeringsnyckel — visas bara en gång:</p>
                <div className="flex items-center gap-2">
                  <code className="break-all font-mono text-xs">{newSecret}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText(newSecret)
                      toast({ title: 'Nyckeln kopierad' })
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* List */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Registrerade webhooks</CardTitle>
          </CardHeader>
          <CardContent>
            {webhooks === null ? (
              <Skeleton className="h-20 w-full" />
            ) : webhooks.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Inga webhooks registrerade.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Namn</TableHead>
                    <TableHead>Händelse</TableHead>
                    <TableHead>URL</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Åtgärd</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {webhooks.map((w) => (
                    <TableRow key={w.id}>
                      <TableCell>{w.name}</TableCell>
                      <TableCell><code className="text-xs">{w.event_type}</code></TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs">{w.webhook_url}</TableCell>
                      <TableCell>
                        {w.active && !w.disabled_at ? (
                          <Badge variant="success">Aktiv</Badge>
                        ) : (
                          <Badge variant="destructive" title={w.disabled_reason ?? undefined}>Inaktiverad</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDelete(w.id)}
                          disabled={busyId === w.id}
                        >
                          Ta bort
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Deliveries */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Senaste leveranser</CardTitle>
          </CardHeader>
          <CardContent>
            {deliveries.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Inga leveranser än.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Händelse</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Försök</TableHead>
                    <TableHead>Svar</TableHead>
                    <TableHead>Tidpunkt</TableHead>
                    <TableHead className="text-right">Åtgärd</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deliveries.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell><code className="text-xs">{d.event_type}</code></TableCell>
                      <TableCell>
                        <Badge variant={DELIVERY_BADGE[d.status]} title={d.error ?? undefined}>
                          {d.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">{d.attempts}</TableCell>
                      <TableCell className="tabular-nums">{d.response_status ?? '—'}</TableCell>
                      <TableCell className="tabular-nums">{formatDate(d.created_at)}</TableCell>
                      <TableCell className="text-right">
                        {(d.status === 'dead' || d.status === 'delivered') && d.webhook_id && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRedeliver(d.id)}
                            disabled={busyId === d.id}
                          >
                            Skicka om
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
