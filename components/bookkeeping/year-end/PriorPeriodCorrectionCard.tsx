'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { useCompany } from '@/contexts/CompanyContext'
import { formatCurrency, formatDate } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import type { BASAccount, FiscalPeriod } from '@/types'

type Method = 'current_year' | 'equity_restatement'

interface Line {
  account_number: string
  debit: string
  credit: string
}

interface BookedCorrection {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
}

const EMPTY_LINE: Line = { account_number: '', debit: '', credit: '' }
const toAmount = (value: string) => roundOre(Number(value.replace(',', '.')) || 0)

/**
 * Rättelse av fel från ett stängt räkenskapsår vars årsredovisning inte
 * längre kan ändras. Rättelsen bokförs som en ny verifikation i ett senare,
 * öppet räkenskapsår; ursprungsverifikationerna lämnas orörda.
 */
export default function PriorPeriodCorrectionCard({
  periodId,
  companySuffix = '',
}: {
  periodId: string
  companySuffix?: string
}) {
  const { toast } = useToast()
  const { company, canWrite } = useCompany()
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [accounts, setAccounts] = useState<BASAccount[]>([])
  const [booked, setBooked] = useState<BookedCorrection[]>([])
  const [method, setMethod] = useState<Method>('current_year')
  const [targetId, setTargetId] = useState('')
  const [entryDate, setEntryDate] = useState('')
  const [description, setDescription] = useState('')
  const [reason, setReason] = useState('')
  const [reference, setReference] = useState('')
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY_LINE }, { ...EMPTY_LINE }])
  const [submitting, setSubmitting] = useState(false)
  const [issues, setIssues] = useState<string[]>([])

  const bookedUrl = `/api/bookkeeping/fiscal-periods/${periodId}/prior-period-correction${companySuffix}`
  const fetchBooked = useCallback(
    () =>
      fetch(bookedUrl)
        .then((r) => (r.ok ? r.json() : { data: [] }))
        .then((body) => (body.data ?? []) as BookedCorrection[]),
    [bookedUrl],
  )

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/bookkeeping/fiscal-periods').then((r) => r.json()),
      fetch('/api/bookkeeping/accounts').then((r) => r.json()),
      fetchBooked(),
    ])
      .then(([p, a, b]) => {
        if (cancelled) return
        setPeriods(p.data ?? [])
        setAccounts(a.data ?? [])
        setBooked(b)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [fetchBooked])

  const erroneous = periods.find((p) => p.id === periodId)
  const targets = useMemo(
    () =>
      erroneous
        ? periods
            .filter((p) => !p.is_closed && !p.locked_at && p.period_start > erroneous.period_end)
            .sort((a, b) => a.period_start.localeCompare(b.period_start))
        : [],
    [periods, erroneous],
  )
  const target = targets.find((p) => p.id === targetId) ?? targets[0]
  const canRestate = company?.entity_type === 'aktiebolag' && company?.accounting_framework === 'k3'

  if (!erroneous?.is_closed) return null

  const debit = roundOre(lines.reduce((s, l) => s + toAmount(l.debit), 0))
  const credit = roundOre(lines.reduce((s, l) => s + toAmount(l.credit), 0))
  const balanced = debit > 0 && debit === credit
  // Default to today, kept inside the target year.
  const today = new Date().toISOString().slice(0, 10)
  const date = entryDate || (target ? [target.period_start, today, target.period_end].sort()[1] : '')

  const updateLine = (index: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))

  async function submit() {
    if (!target) return
    setIssues([])
    if (reason.trim().length < 20 || description.trim().length < 3 || !balanced) {
      toast({
        title: 'Komplettera rättelsen',
        description: 'Ange beskrivning, orsak (minst 20 tecken) och rader som balanserar.',
        variant: 'destructive',
      })
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(bookedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method,
          fiscal_period_id: target.id,
          entry_date: date,
          description: description.trim(),
          reason: reason.trim(),
          original_reference: reference.trim() || undefined,
          lines: lines
            .filter((l) => l.account_number && (toAmount(l.debit) > 0 || toAmount(l.credit) > 0))
            .map((l) => ({ account_number: l.account_number, debit_amount: toAmount(l.debit), credit_amount: toAmount(l.credit) })),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const found: { message: string }[] = body.error?.details?.issues ?? []
        setIssues(found.map((i) => i.message))
        toast({
          title: 'Rättelsen kunde inte bokföras',
          description: typeof body.error === 'string' ? body.error : body.error?.message,
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Rättelsen är bokförd', description: body.data?.description })
      setDescription('')
      setReason('')
      setReference('')
      setLines([{ ...EMPTY_LINE }, { ...EMPTY_LINE }])
      void fetchBooked().then(setBooked)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card id="prior-period-correction">
      <CardHeader>
        <CardTitle className="text-base">Rätta fel från {erroneous.name} i ett senare år</CardTitle>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            När årsredovisningen är fastställd eller inlämnad ändras inte det stängda året. Felet rättas i stället
            med en ny verifikation i ett öppet räkenskapsår. Ursprungsverifikationerna lämnas orörda, och det framgår
            vad som rättats, när och av vem (BFL 5 kap. 5 §).
          </p>
          <p>
            Är årsredovisningen ännu inte fastställd? Begär då hellre återöppning ovan, så att rättelsen hamnar i rätt år.
            Påverkar felet en inlämnad inkomstdeklaration eller momsdeklaration ska den rättas separat hos Skatteverket
            (omprövning eller rättelse av momsdeklaration).
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {targets.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Det finns inget öppet räkenskapsår efter {erroneous.name}. Skapa nästa räkenskapsår först.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label>Metod</Label>
                <Select value={method} onValueChange={(v) => setMethod(v as Method)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="current_year">Rätta i årets resultat (K1, K2 och K3)</SelectItem>
                    {canRestate && (
                      <SelectItem value="equity_restatement">
                        Väsentligt fel: retroaktiv rättelse mot eget kapital (K3 kap. 10)
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {method === 'current_year'
                    ? 'Rättelsen bokförs på de resultat- eller balanskonton som berörs, i det år felet upptäcks. Jämförelsetalen räknas inte om.'
                    : 'Felets effekt på tidigare år motbokas mot balanserat resultat (2091). Bara balanskonton får användas. Nästa årsredovisning räknar om jämförelsetalen och lämnar upplysning om felet i not.'}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Bokförs i räkenskapsår</Label>
                <Select value={target?.id ?? ''} onValueChange={setTargetId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({p.period_start} – {p.period_end})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ppc-date">Verifikationsdatum</Label>
                <Input
                  id="ppc-date"
                  type="date"
                  value={date}
                  min={target?.period_start}
                  max={target?.period_end}
                  onChange={(e) => setEntryDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ppc-description">Beskrivning</Label>
                <Input
                  id="ppc-description"
                  value={description}
                  maxLength={200}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Exempel: Ej bokförd leverantörsfaktura"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ppc-reference">Felaktig verifikation (valfritt)</Label>
                <Input
                  id="ppc-reference"
                  value={reference}
                  maxLength={200}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Exempel: A47"
                />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="ppc-reason">Orsak och underlag</Label>
                <Textarea
                  id="ppc-reason"
                  value={reason}
                  rows={3}
                  maxLength={1500}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Vad var fel, hur upptäcktes det och vilket underlag styrker rättelsen?"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Rader</Label>
              {lines.map((line, index) => (
                <div key={index} className="grid grid-cols-[1fr_7rem_7rem_2.5rem] items-center gap-2">
                  <AccountCombobox
                    value={line.account_number}
                    accounts={accounts}
                    onChange={(account) => updateLine(index, { account_number: account })}
                  />
                  <Input
                    inputMode="decimal"
                    aria-label="Debet"
                    placeholder="Debet"
                    className="text-right tabular-nums"
                    value={line.debit}
                    onChange={(e) => updateLine(index, { debit: e.target.value, credit: e.target.value ? '' : line.credit })}
                  />
                  <Input
                    inputMode="decimal"
                    aria-label="Kredit"
                    placeholder="Kredit"
                    className="text-right tabular-nums"
                    value={line.credit}
                    onChange={(e) => updateLine(index, { credit: e.target.value, debit: e.target.value ? '' : line.debit })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Ta bort rad"
                    disabled={lines.length <= 2}
                    onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <div className="flex items-center justify-between text-sm">
                <Button variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}>
                  <Plus className="mr-2 h-4 w-4" />
                  Lägg till rad
                </Button>
                <span className="tabular-nums text-muted-foreground">
                  {formatCurrency(debit)} / {formatCurrency(credit)}
                  {debit > 0 && !balanced ? ' · balanserar inte' : ''}
                </span>
              </div>
            </div>

            {issues.length > 0 && (
              <ul className="space-y-1 text-sm text-destructive">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}

            <Button onClick={submit} disabled={!canWrite || submitting || !balanced}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Bokför rättelse
            </Button>
          </>
        )}

        {booked.length > 0 && (
          <div className="space-y-2 border-t border-border pt-4 text-sm">
            <p className="font-medium">Bokförda rättelser för {erroneous.name}</p>
            {booked.map((entry) => (
              <Link
                key={entry.id}
                href={`/bookkeeping/${entry.id}`}
                className="flex justify-between gap-3 rounded-md px-2 py-1 hover:bg-secondary/60"
              >
                <span className="truncate">
                  {entry.voucher_series}
                  {entry.voucher_number} · {entry.description}
                </span>
                <span className="tabular-nums text-muted-foreground">{formatDate(entry.entry_date)}</span>
              </Link>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
