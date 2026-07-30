'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  FileCheck2,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { PageHeader } from '@/components/ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import {
  HISTORICAL_WORKPAPER_LABELS,
  historicalWorkpaperSourceLabel,
  historicalWorkpaperStatusLabel,
  isAccountingErrorStatus,
  isCompletedStatus,
  isConfirmationStatus,
  type HistoricalWorkpaperCategory,
  type HistoricalWorkpaperStatus,
} from '@/lib/bokslut/historical-workpapers'

type Control = {
  control_code: string
  label: string
  status:
    | HistoricalWorkpaperStatus
    | 'reconciled'
    | 'manual_verification_required'
    | 'accounting_error'
  ledger_balance: number | null
  support_balance: number | null
  difference: number | null
  is_blocking: boolean
  message: string
  available_actions: string[]
  source_type?: string
  metadata?: Record<string, unknown>
}

type Workpaper = {
  id: string
  category: HistoricalWorkpaperCategory
  source_sie_import_id: string | null
  imported_amount: number | null
  current_amount: number | null
  external_amount: number | null
  actual_difference: number | null
  support_register_available: boolean
  status: HistoricalWorkpaperStatus
  source_type: string
  account_numbers: string[]
  verification_method: string | null
  comment: string | null
  pending_sie_import_id: string | null
  pending_imported_amount: number | null
  conflict_detected_at: string | null
  confirmed_by_name: string | null
  confirmed_at: string | null
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
  profit_disposition_proposal: {
    current_year_result: number
    free_equity: number
    proposed_dividend: number
    carried_forward: number
    proposal_text: string
  }
  workpapers: Workpaper[]
  workpaper_events: Array<{
    id: string
    workpaper_id: string
    event_type: string
    reason: string | null
    created_at: string
  }>
  control_accounts: Record<string, string[]>
  source_import: {
    id: string
    filename: string
    sie_type: number
    accounts_count: number
    transactions_count: number
    total_vouchers: number
    posted_vouchers: number
    imported_at: string
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
  const [selectedWorkpapers, setSelectedWorkpapers] = useState<Set<string>>(new Set())
  const focus = search.get('focus')

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
      const workspace = body.data as Workspace
      setData(workspace)
      setSelectedWorkpapers(
        new Set(
          workspace.workpapers
            .filter((workpaper) => workpaper.status === 'imported_from_sie')
            .map((workpaper) => workpaper.id),
        ),
      )
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

  useEffect(() => {
    if (!data || !focus) return
    const timer = setTimeout(() => {
      document.getElementById(`control-${focus}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    }, 100)
    return () => clearTimeout(timer)
  }, [data, focus])

  const groupedControls = useMemo(() => {
    const controls = data?.controls ?? []
    return {
      completed: controls.filter((control) => isCompletedStatus(control.status)),
      confirmation: controls.filter((control) => isConfirmationStatus(control.status)),
      errors: controls.filter((control) => isAccountingErrorStatus(control.status)),
    }
  }, [data])

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
      control_account: form.get('control_account'),
      comment: form.get('comment') || undefined,
    })
    event.currentTarget.reset()
  }

  const acceptSelectedWorkpapers = async () => {
    if (selectedWorkpapers.size === 0) return
    await postJson({
      action: 'accept_sie_workpapers',
      workpaper_ids: [...selectedWorkpapers],
      comment: 'Importerat SIE-saldo granskat och accepterat som historiskt bokslutsunderlag.',
    })
  }

  const resolveConflict = async (workpaperId: string, choice: 'keep' | 'replace') => {
    await postJson({
      action: 'accept_sie_workpapers',
      workpaper_ids: [workpaperId],
      comment:
        choice === 'replace'
          ? 'Det nya SIE-saldot ersätter tidigare bokslutsunderlag efter uttrycklig granskning.'
          : 'Tidigare bokslutsunderlag behålls efter uttrycklig granskning av den nya SIE-importen.',
      reimport_choice: choice,
    })
  }

  const submitWorkpaperAdjustment = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await postJson({
      action: 'adjust_workpaper',
      workpaper_id: form.get('workpaper_id'),
      amount: Number(form.get('amount')),
      adjustment_kind: form.get('adjustment_kind'),
      comment: form.get('comment'),
    })
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
    <div className="space-y-8">
      <Button variant="ghost" size="sm" asChild className="-ml-3">
        <Link href={backHref}><ArrowLeft className="mr-2 h-4 w-4" />Till bokslutet</Link>
      </Button>
      <PageHeader
        title="Bokslutsunderlag"
        description={`${data?.period.name ?? ''} · Bekräfta det som redan finns i SIE och komplettera bara det som faktiskt saknas.`}
        action={(
          <Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCw className="mr-2 h-4 w-4" />Uppdatera
          </Button>
        )}
      />

      {error && (
        <Card><CardContent className="flex gap-2 p-4 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />{error}
        </CardContent></Card>
      )}

      {data && (
        <>
          {data.source_import && (
            <Card>
              <CardHeader><CardTitle className="text-base">Importerad bokföring</CardTitle></CardHeader>
              <CardContent className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">Fil</p>
                  <p>{data.source_import.filename}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">SIE-typ</p>
                  <p className="tabular-nums">SIE {data.source_import.sie_type}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Konton</p>
                  <p className="tabular-nums">{data.source_import.accounts_count}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Verifikationer</p>
                  <p className="tabular-nums">
                    {data.source_import.posted_vouchers} av {data.source_import.total_vouchers}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          <ControlGroup
            title="Klart automatiskt"
            description="Underlag som har kunnat läsas, härledas eller redan har bekräftats."
            controls={groupedControls.completed}
            icon={<CheckCircle2 className="h-4 w-4" />}
          />
          <ControlGroup
            title="Behöver bekräftas"
            description="Granska och bekräfta. Detta är inte ett konstaterat bokföringsfel."
            controls={groupedControls.confirmation}
            icon={<FileCheck2 className="h-4 w-4" />}
          />
          <ControlGroup
            title="Måste åtgärdas"
            description="Här finns en verklig differens eller ett blockerande bokföringsfel."
            controls={groupedControls.errors}
            icon={<CircleAlert className="h-4 w-4 text-destructive" />}
          />

          <Card>
            <CardHeader className="flex-row items-center justify-between gap-4">
              <div>
                <CardTitle className="text-base">Importerade historiska saldon</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  Saknat stödregister visas som saknat – aldrig som 0 kr.
                </p>
              </div>
              <Button
                disabled={busy || selectedWorkpapers.size === 0}
                onClick={() => void acceptSelectedWorkpapers()}
              >
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Bekräfta valda ({selectedWorkpapers.size})
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"><span className="sr-only">Välj</span></TableHead>
                      <TableHead>Område</TableHead>
                      <TableHead>Källa</TableHead>
                      <TableHead>Konton</TableHead>
                      <TableHead className="text-right">Importerat värde</TableHead>
                      <TableHead className="text-right">Aktuellt värde</TableHead>
                      <TableHead className="text-right">Differens</TableHead>
                      <TableHead>Detaljstöd</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Senast verifierat</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.workpapers.map((workpaper) => (
                      <TableRow key={workpaper.id}>
                        <TableCell>
                          <Checkbox
                            aria-label={`Välj ${HISTORICAL_WORKPAPER_LABELS[workpaper.category]}`}
                            disabled={workpaper.status !== 'imported_from_sie'}
                            checked={selectedWorkpapers.has(workpaper.id)}
                            onCheckedChange={(checked) => {
                              setSelectedWorkpapers((current) => {
                                const next = new Set(current)
                                if (checked) next.add(workpaper.id)
                                else next.delete(workpaper.id)
                                return next
                              })
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <p>{HISTORICAL_WORKPAPER_LABELS[workpaper.category]}</p>
                          {workpaper.pending_sie_import_id && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                onClick={() => void resolveConflict(workpaper.id, 'keep')}
                              >
                                Behåll tidigare
                              </Button>
                              <Button
                                size="sm"
                                disabled={busy}
                                onClick={() => void resolveConflict(workpaper.id, 'replace')}
                              >
                                Använd ny import
                              </Button>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>{historicalWorkpaperSourceLabel(workpaper.source_type)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {workpaper.account_numbers.join(', ') || '–'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatAmount(workpaper.imported_amount)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatAmount(workpaper.current_amount)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatAmount(workpaper.actual_difference)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {workpaper.support_register_available
                            ? workpaper.verification_method || 'Tillgängligt'
                            : 'Saknas i Nordklart'}
                        </TableCell>
                        <TableCell>
                          <Badge variant={workpaperBadgeVariant(workpaper.status)}>
                            {workpaper.pending_sie_import_id
                              ? 'Konflikt vid återimport'
                              : historicalWorkpaperStatusLabel(workpaper.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {workpaper.confirmed_at
                            ? `${new Intl.DateTimeFormat('sv-SE', {
                                dateStyle: 'short',
                                timeStyle: 'short',
                              }).format(new Date(workpaper.confirmed_at))} · ${workpaper.confirmed_by_name ?? 'Användare'}`
                            : '–'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Manuell komplettering</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={(event) => void submitWorkpaperAdjustment(event)}
                className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
              >
                <Field label="Område">
                  <select
                    name="workpaper_id"
                    required
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {data.workpapers.map((workpaper) => (
                      <option key={workpaper.id} value={workpaper.id}>
                        {HISTORICAL_WORKPAPER_LABELS[workpaper.category]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Belopp">
                  <Input name="amount" type="number" step="0.01" required />
                </Field>
                <Field label="Typ av ändring">
                  <select
                    name="adjustment_kind"
                    required
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="verification_only">Endast verifieringsuppgift</option>
                    <option value="support_register_completion">Historiskt stödregister</option>
                    <option value="annual_report_reclassification">Omklassificering i årsredovisning</option>
                    <option value="comment">Kommentar eller dokumentation</option>
                    <option value="accounting_correction">Bokföringsmässig korrigering</option>
                  </select>
                </Field>
                <Field label="Ändringsorsak">
                  <Input name="comment" required />
                </Field>
                <div className="sm:col-span-2 lg:col-span-4 flex justify-end">
                  <Button type="submit" variant="outline" disabled={busy}>
                    Spara utan ny bokföring
                  </Button>
                </div>
              </form>
              <p className="mt-3 text-xs text-muted-foreground">
                Om beloppet avviker från huvudboken markeras en verklig differens. En
                bokföringsmässig korrigering skickas vidare till rättelseflödet och skapar
                aldrig automatiskt en verifikation här.
              </p>
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
              controlAccounts={data.control_accounts.customer_receivables ?? []}
              disabled={busy}
              onSubmit={submitOpenItem}
              onEvidence={submitItemEvidence}
            />
            <OpenItemsCard
              title="Historisk leverantörsreskontra"
              kind="ap"
              rows={data.payables}
              controlAccounts={data.control_accounts.supplier_payables ?? []}
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
                  <Input name="current_year_result" type="number" step="0.01" required defaultValue={data.profit_disposition?.current_year_result ?? data.profit_disposition_proposal.current_year_result} />
                </Field>
                <Field label="Fritt eget kapital">
                  <Input name="free_equity" type="number" min="0" step="0.01" required defaultValue={data.profit_disposition?.free_equity ?? data.profit_disposition_proposal.free_equity} />
                </Field>
                <Field label="Föreslagen utdelning">
                  <Input name="proposed_dividend" type="number" min="0" step="0.01" required defaultValue={data.profit_disposition?.proposed_dividend ?? data.profit_disposition_proposal.proposed_dividend} />
                </Field>
                <Field label="Balanseras i ny räkning">
                  <Input name="carried_forward" type="number" min="0" step="0.01" required defaultValue={data.profit_disposition?.carried_forward ?? data.profit_disposition_proposal.carried_forward} />
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
                Förslag: {data.profit_disposition_proposal.proposal_text}{' '}
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
  controlAccounts,
  disabled,
  onSubmit,
  onEvidence,
}: {
  title: string
  kind: 'ar' | 'ap'
  rows: OpenItem[]
  controlAccounts: string[]
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
          <Field label="Kontrollkonto">
            <select
              name="control_account"
              required
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {controlAccounts.map((account) => (
                <option key={account} value={account}>{account}</option>
              ))}
            </select>
          </Field>
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

function ControlGroup({
  title,
  description,
  controls,
  icon,
}: {
  title: string
  description: string
  controls: Control[]
  icon: React.ReactNode
}) {
  if (controls.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {controls.map((control) => (
          <div
            id={`control-${control.control_code}`}
            key={control.control_code}
            className="grid scroll-mt-24 gap-3 rounded-md border p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
          >
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{control.label}</p>
                <Badge variant={controlBadgeVariant(control)}>
                  {historicalWorkpaperStatusLabel(control.status)}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{control.message}</p>
              {(control.ledger_balance != null || control.support_balance != null) && (
                <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                  Huvudbok {formatAmount(control.ledger_balance)}
                  {' · '}Underlag {formatAmount(control.support_balance)}
                  {' · '}Differens {formatAmount(control.difference)}
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {historicalWorkpaperSourceLabel(control.source_type ?? 'system_calculation')}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function controlBadgeVariant(
  control: Control,
): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (isAccountingErrorStatus(control.status)) return 'destructive'
  if (isConfirmationStatus(control.status)) return 'warning'
  return control.status === 'imported_from_sie' ? 'secondary' : 'success'
}

function workpaperBadgeVariant(
  status: HistoricalWorkpaperStatus,
): 'success' | 'warning' | 'destructive' | 'secondary' {
  if (isAccountingErrorStatus(status)) return 'destructive'
  if (isConfirmationStatus(status)) return 'warning'
  return status === 'imported_from_sie' ? 'secondary' : 'success'
}

function formatAmount(value: number | null): string {
  return value == null ? '–' : money.format(Number(value))
}
