import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateLong } from '@/lib/utils'

export type BolagsverketSnapshot = {
  id: string
  lookup_status: 'not_requested' | 'verified' | 'not_found' | 'ceased' | 'manual_review'
  organization_number: string | null
  normalized_data: Record<string, unknown>
  retrieved_at: string | null
  updated_at?: string | null
}

export type BolagsverketDiffRow = {
  field: string
  labelSv: string
  currentValue: string | null
  registryValue: string | null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function addressLabel(data: Record<string, unknown>) {
  return [
    text(data.address_line1),
    [text(data.postal_code), text(data.city)].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ')
}

function sniCodes(data: Record<string, unknown>) {
  const values = Array.isArray(data.sni_codes) ? data.sni_codes : []
  return values
    .map((item) => item && typeof item === 'object' ? item as { code?: unknown; name?: unknown } : null)
    .filter((item): item is { code?: unknown; name?: unknown } => Boolean(item))
    .map((item) => ({ code: text(item.code), name: text(item.name) }))
    .filter((item): item is { code: string; name: string } => Boolean(item.code && item.name))
}

export function BolagsverketRegistryView({
  snapshot,
  diff,
  loading,
  applying,
  onSync,
  onApply,
}: {
  snapshot: BolagsverketSnapshot | null
  diff: BolagsverketDiffRow[]
  loading: boolean
  applying: boolean
  onSync: () => void
  onApply: () => void
}) {
  const data = snapshot?.normalized_data ?? {}
  const status = snapshot?.lookup_status
  const statusLabel = status === 'verified'
    ? 'Verifierad'
    : status === 'manual_review'
      ? 'Kontroll behövs'
      : status === 'ceased'
        ? 'Avregistrerad'
        : status === 'not_found'
          ? 'Ej hittad'
          : 'Ej hämtad'

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">Registeruppgifter från Bolagsverket</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Källa: Bolagsverket / Värdefulla datamängder. Bokföringsmetod, momsperiod och F-skatt hanteras separat.
          </p>
          {snapshot?.retrieved_at ? (
            <p className="mt-1 text-xs text-muted-foreground">Senast hämtad {formatDateLong(snapshot.retrieved_at)}</p>
          ) : null}
        </div>
        <Badge variant={status === 'ceased' ? 'destructive' : 'secondary'} className="font-normal">
          {statusLabel}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        {snapshot ? (
          <div className="space-y-4">
            <div>
              <p className="font-display text-xl tracking-tight">{text(data.company_name) ?? 'Okänt företag'}</p>
              <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                {[snapshot.organization_number, text(data.legal_form), text(data.organization_form_text)].filter(Boolean).join(' · ')}
              </p>
              {addressLabel(data) ? <p className="mt-2 text-sm text-muted-foreground">{addressLabel(data)}</p> : null}
            </div>

            {text(data.business_description) ? (
              <section>
                <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">Verksamhet</h3>
                <p className="text-sm leading-6 text-muted-foreground">{text(data.business_description)}</p>
              </section>
            ) : null}

            {text(data.registration_date) ? (
              <section>
                <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">Registreringsdatum</h3>
                <p className="text-sm text-muted-foreground tabular-nums">{text(data.registration_date)}</p>
              </section>
            ) : null}

            {sniCodes(data).length > 0 ? (
              <section>
                <h3 className="mb-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">SNI-koder</h3>
                <ul className="space-y-1">
                  {sniCodes(data).map((sni) => (
                    <li key={`${sni.code}-${sni.name}`} className="text-sm tabular-nums">
                      <span className="text-foreground">{sni.code}</span>{' '}
                      <span className="text-muted-foreground">{sni.name}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Inga registeruppgifter har sparats ännu. Hämta från Bolagsverket med företagets organisationsnummer.
          </p>
        )}

        {diff.length > 0 ? (
          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="text-sm font-medium">Skillnader mot dina företagsinställningar</p>
            <dl className="mt-3 space-y-2 text-sm">
              {diff.map((row) => (
                <div key={row.field} className="grid gap-1 sm:grid-cols-[140px_1fr]">
                  <dt className="text-muted-foreground">{row.labelSv}</dt>
                  <dd>
                    <span className="line-through decoration-muted-foreground/60">{row.currentValue ?? '—'}</span>
                    <span className="mx-2 text-muted-foreground">→</span>
                    <span className="font-medium">{row.registryValue}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="secondary" onClick={onSync} disabled={loading || applying}>
            {loading ? 'Hämtar…' : 'Uppdatera från Bolagsverket'}
          </Button>
          {diff.length > 0 ? (
            <Button type="button" onClick={onApply} disabled={loading || applying}>
              {applying ? 'Uppdaterar…' : 'Använd registeruppgifter'}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
