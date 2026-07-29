'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'

type Control = {
  control_code: string
  label: string
  status: 'reconciled' | 'completion_required' | 'manual_verification_required' | 'accounting_error'
  ledger_balance: number | null
  support_balance: number | null
  difference: number | null
  is_blocking: boolean
  message: string
  available_actions: string[]
}

type OpenItem = {
  id: string
  customer_name_snapshot?: string
  supplier_name_snapshot?: string
  invoice_number?: string
  supplier_invoice_number?: string
  due_date: string
  remaining_amount_sek_at_balance_date: number
  control_account: string
}

type Workspace = {
  period: { name: string; period_end: string; is_closed: boolean; locked_at: string | null }
  controls: Control[]
  receivables: OpenItem[]
  payables: OpenItem[]
  company_snapshot: {
    legal_name: string
    organisation_number: string
    locked_at: string | null
  } | null
  profit_disposition: {
    current_year_result: number
    free_equity: number
    proposed_dividend: number
    carried_forward: number
    status: string
    narrative_override: string | null
  } | null
  annotations: Array<{
    id: string
    target_type: string
    target_id: string | null
    visibility: string
    annotation_text: string
  }>
}

const money = new Intl.NumberFormat('sv-SE', {
  style: 'currency',
  currency: 'SEK',
  minimumFractionDigits: 2,
})

export default function HistoricalSupportPage() {
  const search = useSearchParams()
  const periodId = search.get('period')
  const companyId = search.get('company_id')
  const { toast } = useToast()
  const [data, setData] = useState<Workspace | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)

  const suffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : ''
  const load = useCallback(async () => {
    if (!periodId || !companyId) {
      setError('Både företag och räkenskapsår måste anges.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/bookkeeping/fiscal-periods/${encodeURIComponent(periodId)}/historical-support${suffix}`,
      )
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? 'Underlagen kunde inte hämtas.')
      setData(body.data)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Underlagen kunde inte hämtas.')
    } finally {
      setLoading(false)
    }
  }, [periodId, companyId, suffix])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0)
    return () => clearTimeout(timer)
  }, [load, refresh])

  const postJson = async (payload: Record<string, unknown>) => {
    if (!periodId) return
    setBusy(true)
    try {
      const response = await fetch(
        `/api/bookkeeping/fiscal-periods/${encodeURIComponent(periodId)}/historical-support${suffix}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? 'Åtgärden misslyckades.')
      toast({ title: 'Sparat', description: 'Bokslutsunderlaget har uppdaterats.' })
      setRefresh((value) => value + 1)
    } catch (postError) {
      toast({
        title: 'Kunde inte spara',
        description: postError instanceof Error ? postError.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  const submitOpenItem = async (event: FormEvent<HTMLFormElement>, kind: 'ar' | 'ap') => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await postJson({
      action: 'add_open_item',
      kind,
      counterparty_name: form.get('counterparty_name'),
      invoice_number: form.get('invoice_number'),
      invoice_date: form.get('invoice_date'),
      due_date: form.get('due_date'),
      currency: 'SEK',
      original_amount_currency: Number(form.get('amount')),
      paid_amount_currency: 0,
      remaining_amount_currency: Number(form.get('amount')),
      control_account: kind === 'ar' ? '1510' : '2440',
      comment: form.get('comment') || undefined,
    })
    event.currentTarget.reset()
  }

  const submitProfitDisposition = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const optionalNumber = (name: string) => {
      const value = String(form.get(name) ?? '').trim()
      return value ? Number(value) : undefined
    }
    await postJson({
      action: 'save_profit_disposition',
      current_year_result: Number(form.get('current_year_result')),
      free_equity: Number(form.get('free_equity')),
      proposed_dividend: Number(form.get('proposed_dividend')),
      carried_forward: Number(form.get('carried_forward')),
      amount_per_share: optionalNumber('amount_per_share'),
      share_count: optionalNumber('share_count'),
      planned_payment_date: form.get('planned_payment_date') || undefined,
      board_reasoning: form.get('board_reasoning') || undefined,
      prudence_assessment: form.get('prudence_assessment') || undefined,
      narrative_override: form.get('narrative_override') || undefined,
    })
  }

  const submitAnnotation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await postJson({
      action: 'add_annotation',
      target_type: form.get('target_type'),
      target_id: form.get('target_id') || undefined,
      visibility: form.get('visibility'),
      annotation_text: form.get('annotation_text'),
    })
    event.currentTarget.reset()
  }

  const submitEvidence = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!periodId) return
    setBusy(true)
    const form = new FormData(event.currentTarget)
    try {
      const response = await fetch(
        `/api/bookkeeping/fiscal-periods/${encodeURIComponent(periodId)}/historical-support/evidence${suffix}`,
        { method: 'POST', body: form },
      )
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? 'Verifieringen misslyckades.')
      toast({ title: 'Verifierat', description: 'Underlaget är arkiverat och differensen är noll.' })
      setRefresh((value) => value + 1)
      event.currentTarget.reset()
    } catch (submitError) {
      toast({
        title: 'Kunde inte verifiera',
        description: submitError instanceof Error ? submitError.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  const submitItemEvidence = async (
    event: FormEvent<HTMLFormElement>,
    kind: 'ar' | 'ap',
    itemId: string,
  ) => {
    event.preventDefault()
    if (!periodId) return
    const form = new FormData(event.currentTarget)
    form.set('category', `${kind}_item`)
    form.set('item_id', itemId)
    setBusy(true)
    try {
      const response = await fetch(
        `/api/bookkeeping/fiscal-periods/${encodeURIComponent(periodId)}/historical-support/evidence${suffix}`,
        { method: 'POST', body: form },
      )
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? 'Underlaget kunde inte sparas.')
      toast({ title: 'Underlag sparat' })
      setRefresh((value) => value + 1)
    } catch (submitError) {
      toast({
        title: 'Kunde inte spara underlag',
        description: submitError instanceof Error ? submitError.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  const backHref =
    periodId && companyId
      ? `/bookkeeping/year-end?period=${encodeURIComponent(periodId)}&company_id=${encodeURIComponent(companyId)}`
      : '/bookkeeping/year-end'

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Hämtar bokslutsunderlag…</div>
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-3">
            <Link href={backHref}><ArrowLeft className="mr-2 h-4 w-4" />Till bokslutet</Link>
          </Button>
          <h1 className="text-2xl font-semibold">Historiska bokslutsunderlag</h1>
          <p className="text-sm text-muted-foreground">
            {data?.period.name} · stödregistren förklarar huvudboken utan att skapa ny bokföring.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw className="mr-2 h-4 w-4" />Uppdatera
        </Button>
      </div>

      {error && (
        <Card><CardContent className="flex gap-2 p-4 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />{error}
        </CardContent></Card>
      )}

      {data && (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">Kontrollöversikt</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr><th className="pb-2">Kontroll</th><th>Huvudbok</th><th>Underlag</th><th>Differens</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {data.controls.map((control) => (
                    <tr key={control.control_code} className="border-b last:border-0">
                      <td className="py-3 pr-4"><p className="font-medium">{control.label}</p><p className="text-xs text-muted-foreground">{control.message}</p></td>
                      <td className="tabular-nums">{formatAmount(control.ledger_balance)}</td>
                      <td className="tabular-nums">{formatAmount(control.support_balance)}</td>
                      <td className="tabular-nums">{formatAmount(control.difference)}</td>
                      <td><Badge variant={control.is_blocking ? 'destructive' : 'success'}>{control.status === 'reconciled' ? 'Avstämd' : 'Åtgärd krävs'}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Företagssnapshot</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap items-center justify-between gap-3">
              {data.company_snapshot ? (
                <div className="text-sm">
                  <p className="font-medium">{data.company_snapshot.legal_name}</p>
                  <p className="text-muted-foreground">{data.company_snapshot.organisation_number}</p>
                </div>
              ) : <p className="text-sm text-muted-foreground">Ingen bekräftad snapshot finns.</p>}
              <Button
                disabled={busy || Boolean(data.company_snapshot?.locked_at)}
                onClick={() => void postJson({ action: 'create_company_snapshot', lock: true })}
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {data.company_snapshot?.locked_at ? 'Snapshot låst' : 'Bekräfta och lås profiluppgifter'}
              </Button>
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <OpenItemsCard
              title="Historisk kundreskontra"
              kind="ar"
              rows={data.receivables}
              disabled={busy}
              onSubmit={submitOpenItem}
              onEvidence={submitItemEvidence}
            />
            <OpenItemsCard
              title="Historisk leverantörsreskontra"
              kind="ap"
              rows={data.payables}
              disabled={busy}
              onSubmit={submitOpenItem}
              onEvidence={submitItemEvidence}
            />
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Strukturerad resultatdisposition</CardTitle></CardHeader>
            <CardContent>
              <form onSubmit={submitProfitDisposition} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Årets resultat">
                  <Input name="current_year_result" type="number" step="0.01" required defaultValue={data.profit_disposition?.current_year_result} />
                </Field>
                <Field label="Fritt eget kapital">
                  <Input name="free_equity" type="number" min="0" step="0.01" required defaultValue={data.profit_disposition?.free_equity} />
                </Field>
                <Field label="Föreslagen utdelning">
                  <Input name="proposed_dividend" type="number" min="0" step="0.01" required defaultValue={data.profit_disposition?.proposed_dividend ?? 0} />
                </Field>
                <Field label="Balanseras i ny räkning">
                  <Input name="carried_forward" type="number" min="0" step="0.01" required defaultValue={data.profit_disposition?.carried_forward} />
                </Field>
                <Field label="Belopp per aktie"><Input name="amount_per_share" type="number" min="0" step="0.000001" /></Field>
                <Field label="Antal aktier"><Input name="share_count" type="number" min="1" step="1" /></Field>
                <Field label="Planerad utbetalning"><Input name="planned_payment_date" type="date" /></Field>
                <Field label="Styrelsens motivering"><Input name="board_reasoning" /></Field>
                <Field label="Försiktighetsbedömning"><Input name="prudence_assessment" /></Field>
                <div className="sm:col-span-2 lg:col-span-3">
                  <Field label="Kontrollerad formulering i årsredovisningen">
                    <Input name="narrative_override" defaultValue={data.profit_disposition?.narrative_override ?? ''} />
                  </Field>
                </div>
                <div className="sm:col-span-2 lg:col-span-4 flex justify-end">
                  <Button disabled={busy} type="submit">Godkänn resultatdisposition</Button>
                </div>
              </form>
              <p className="mt-3 text-xs text-muted-foreground">
                Ett utdelningsförslag bokför inte någon skuld i det avslutade året. Belopp per aktie, antal aktier, datum och motiveringar krävs när utdelningen är större än noll.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Extern eller manuell verifiering</CardTitle></CardHeader>
            <CardContent>
              <form onSubmit={submitEvidence} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <Field label="Kontroll">
                  <select name="category" required className="h-10 w-full rounded-md border bg-background px-3 text-sm">
                    <option value="ar">Extern kundreskontra</option>
                    <option value="ap">Extern leverantörsreskontra</option>
                    <option value="equity">Eget kapital</option>
                    <option value="tax">Skatt</option>
                    <option value="vat">Moms</option>
                  </select>
                </Field>
                <Field label="Verifierat saldo"><Input name="verified_balance" type="number" step="0.01" required /></Field>
                <Field label="Metod"><Input name="verification_method" defaultValue="Manuellt underlag" required /></Field>
                <Field label="Kommentar"><Input name="comment" required /></Field>
                <Field label="Underlag"><Input name="file" type="file" accept=".pdf,image/jpeg,image/png,image/webp" required /></Field>
                <div className="sm:col-span-2 lg:col-span-5 flex justify-end">
                  <Button disabled={busy} type="submit">{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Verifiera mot huvudboken</Button>
                </div>
              </form>
              <p className="mt-3 text-xs text-muted-foreground">
                För eget kapital ska saldot även motsvara ingående kapital + ökningar − minskningar + årets resultat. De utökade fälten kan skickas via API.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Kommentarer och upplysningar</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {data.annotations.map((annotation) => (
                <div key={annotation.id} className="rounded-md border p-3 text-sm">
                  <div className="mb-1 flex gap-2">
                    <Badge variant="outline">{annotation.target_type}</Badge>
                    <Badge variant="secondary">{annotation.visibility}</Badge>
                  </div>
                  <p>{annotation.annotation_text}</p>
                </div>
              ))}
              <form onSubmit={submitAnnotation} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Område">
                  <select name="target_type" className="h-10 w-full rounded-md border bg-background px-3 text-sm">
                    <option value="year_end">Hela bokslutet</option>
                    <option value="account">Konto</option>
                    <option value="journal_entry">Verifikation</option>
                    <option value="receivable">Kundfordran</option>
                    <option value="payable">Leverantörsskuld</option>
                    <option value="equity">Eget kapital</option>
                    <option value="tax">Skatt</option>
                    <option value="vat">Moms</option>
                    <option value="dividend">Utdelning</option>
                    <option value="annual_report_section">Årsredovisningssektion</option>
                  </select>
                </Field>
                <Field label="Referens"><Input name="target_id" placeholder="Konto, verifikation eller rubrik" /></Field>
                <Field label="Synlighet">
                  <select name="visibility" className="h-10 w-full rounded-md border bg-background px-3 text-sm">
                    <option value="internal">Intern</option>
                    <option value="auditor">Revisor</option>
                    <option value="annual_report">Årsredovisning</option>
                    <option value="tax_return">Deklaration</option>
                  </select>
                </Field>
                <Field label="Text"><Input name="annotation_text" required /></Field>
                <div className="sm:col-span-2 lg:col-span-4 flex justify-end">
                  <Button type="submit" variant="outline" disabled={busy}>Lägg till anteckning</Button>
                </div>
              </form>
              <p className="text-xs text-muted-foreground">
                Endast anteckningar med synligheten Årsredovisning publiceras där. Interna arbetsanteckningar stannar i bokslutet.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function OpenItemsCard({
  title,
  kind,
  rows,
  disabled,
  onSubmit,
  onEvidence,
}: {
  title: string
  kind: 'ar' | 'ap'
  rows: OpenItem[]
  disabled: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>, kind: 'ar' | 'ap') => Promise<void>
  onEvidence: (
    event: FormEvent<HTMLFormElement>,
    kind: 'ar' | 'ap',
    itemId: string,
  ) => Promise<void>
}) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {rows.length > 0 && (
          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.id} className="space-y-2 rounded-md border p-2 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div><p className="font-medium">{row.customer_name_snapshot ?? row.supplier_name_snapshot}</p><p className="text-xs text-muted-foreground">{row.invoice_number ?? row.supplier_invoice_number} · förfallo {row.due_date}</p></div>
                  <span className="tabular-nums">{money.format(Number(row.remaining_amount_sek_at_balance_date))}</span>
                </div>
                <form
                  onSubmit={(event) => void onEvidence(event, kind, row.id)}
                  className="flex items-center gap-2"
                >
                  <Input name="file" type="file" accept=".pdf,image/jpeg,image/png,image/webp" required className="h-8 text-xs" />
                  <Button type="submit" size="sm" variant="ghost" disabled={disabled}>Bifoga</Button>
                </form>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={(event) => void onSubmit(event, kind)} className="grid gap-3 sm:grid-cols-2">
          <Field label={kind === 'ar' ? 'Kund' : 'Leverantör'}><Input name="counterparty_name" required /></Field>
          <Field label="Fakturanummer"><Input name="invoice_number" required /></Field>
          <Field label="Fakturadatum"><Input name="invoice_date" type="date" required /></Field>
          <Field label="Förfallodatum"><Input name="due_date" type="date" required /></Field>
          <Field label="Kvarstående SEK"><Input name="amount" type="number" min="0" step="0.01" required /></Field>
          <Field label="Kommentar"><Input name="comment" /></Field>
          <div className="sm:col-span-2 flex justify-end">
            <Button disabled={disabled} type="submit" variant="outline">
              <CheckCircle2 className="mr-2 h-4 w-4" />Registrera utan bokföring
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label>{label}</Label>{children}</div>
}

function formatAmount(value: number | null): string {
  return value == null ? '–' : money.format(Number(value))
}
