'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { getYearEndApiErrorMessage } from '@/lib/year-end/api-error'
import { formatCurrency, formatDate } from '@/lib/utils'

/**
 * Årsstämmans beslut om utdelning and the payouts, for the balance-sheet year
 * `periodId`. Statutory year-end surface: Swedish only (see i18n rules).
 */

interface DividendState {
  proposal: {
    id: string
    total_amount: number
    amount_per_share: number | null
    share_count: number | null
    planned_payment_date: string | null
  } | null
  decision: {
    id: string
    decision_date: string
    decided_amount: number
    payment_date: string | null
  } | null
  payments: Array<{ id: string; amount: number; paid_on: string }>
  limits: {
    distributable: number
    free_equity_adopted: number
    later_value_transfers: number
    moved_to_restricted_equity: number
  } | null
  prudence: {
    adjustedEquityBefore: number
    adjustedEquityAfter: number
    equityRatioBefore: number | null
    equityRatioAfter: number | null
    cashAfter: number
    warnings: string[]
  } | null
  ku31: { incomeYear: number; dueDate: string } | null
}

const percent = (value: number | null) =>
  value === null ? '–' : `${(value * 100).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} %`

export function DividendDecisionCard({ periodId, companyId }: { periodId: string; companyId: string | null }) {
  const { toast } = useToast()
  const [state, setState] = useState<DividendState | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const suffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : ''
  const url = `/api/bookkeeping/fiscal-periods/${encodeURIComponent(periodId)}/dividend${suffix}`

  const load = useCallback(async () => {
    const response = await fetch(url)
    const body = await response.json().catch(() => null)
    if (response.ok) setState(body.data as DividendState)
  }, [url])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0)
    return () => clearTimeout(timer)
  }, [load, refresh])

  const post = async (payload: Record<string, unknown>, success: string) => {
    setBusy(true)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(getYearEndApiErrorMessage(body, 'Åtgärden misslyckades.', response.status))
      toast({ title: 'Bokfört', description: success })
      setRefresh((value) => value + 1)
    } catch (error) {
      toast({
        title: 'Kunde inte bokföra',
        description: error instanceof Error ? error.message : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  const submitDecision = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await post(
      {
        action: 'decide',
        decision_date: form.get('decision_date'),
        amount: Number(form.get('amount')),
        payment_date: form.get('payment_date') || undefined,
        deviation_reason: form.get('deviation_reason') || undefined,
      },
      'Stämmans beslut är bokfört (Dr 2098/2091, Kr 2898).',
    )
  }

  const submitPayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await post(
      {
        action: 'pay',
        payment_date: form.get('payment_date'),
        amount: Number(form.get('amount')),
        cash_account: form.get('cash_account') || undefined,
      },
      'Utbetalningen är bokförd (Dr 2898, Kr 19xx).',
    )
  }

  if (!state) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Utdelning enligt årsstämman</CardTitle></CardHeader>
        <CardContent><Skeleton className="h-16 w-full" /></CardContent>
      </Card>
    )
  }

  if (!state.proposal) return null

  const paid = state.payments.reduce((sum, p) => sum + Number(p.amount), 0)
  const remaining = state.decision ? Number(state.decision.decided_amount) - paid : 0

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Utdelning enligt årsstämman</CardTitle></CardHeader>
      <CardContent className="space-y-6">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Styrelsens förslag</dt>
            <dd className="tabular-nums">{formatCurrency(Number(state.proposal.total_amount))}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Utdelningsbart (ABL 17:3)</dt>
            <dd className="tabular-nums">{state.limits ? formatCurrency(Number(state.limits.distributable)) : '–'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Soliditet före / efter</dt>
            <dd className="tabular-nums">
              {state.prudence ? `${percent(state.prudence.equityRatioBefore)} / ${percent(state.prudence.equityRatioAfter)}` : '–'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Likvida medel efter utdelning</dt>
            <dd className="tabular-nums">{state.prudence ? formatCurrency(state.prudence.cashAfter) : '–'}</dd>
          </div>
        </dl>
        {state.prudence?.warnings.map((warning) => (
          <p key={warning} className="text-sm text-destructive">{warning}</p>
        ))}

        {!state.decision ? (
          <form onSubmit={submitDecision} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <Label htmlFor="dividend-decision-date">Stämmodatum</Label>
              <Input id="dividend-decision-date" name="decision_date" type="date" required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dividend-amount">Beslutad utdelning</Label>
              <Input id="dividend-amount" name="amount" type="number" min="0.01" step="0.01" required defaultValue={state.proposal.total_amount} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dividend-payment-date">Utbetalningsdag</Label>
              <Input id="dividend-payment-date" name="payment_date" type="date" defaultValue={state.proposal.planned_payment_date ?? ''} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="dividend-deviation">Skäl för avvikelse från förslaget</Label>
              <Input id="dividend-deviation" name="deviation_reason" placeholder="Endast vid högre belopp (ABL 18:1)" />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">
              Kräver att årsredovisningen är fastställd på stämman. Bokförs dagen för stämman: föregående års resultat
              (2098) nollställs, utdelningen krediteras 2898 och resten balanseras på 2091.
            </p>
            <div className="flex justify-end">
              <Button disabled={busy} type="submit">Bokför stämmans beslut</Button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Badge variant="success">Beslutad {formatDate(state.decision.decision_date)}</Badge>
              <span className="tabular-nums">{formatCurrency(Number(state.decision.decided_amount))}</span>
              <span className="text-muted-foreground">
                Utbetalt <span className="tabular-nums">{formatCurrency(paid)}</span>, kvar{' '}
                <span className="tabular-nums">{formatCurrency(remaining)}</span>
              </span>
            </div>
            {state.ku31 ? (
              <p className="text-xs text-muted-foreground">
                Lämna kontrolluppgift KU31 för inkomstår {state.ku31.incomeYear} senast {formatDate(state.ku31.dueDate)}.
                Kryssa fält 061 för företagsledare, närstående och delägare i fåmansföretag. Till mottagare bosatta
                utomlands ska kupongskatt (30 %) innehållas – bokför den utbetalningen manuellt.
              </p>
            ) : null}
            {remaining > 0 ? (
              <form onSubmit={submitPayment} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1">
                  <Label htmlFor="dividend-paid-on">Utbetald</Label>
                  <Input id="dividend-paid-on" name="payment_date" type="date" required defaultValue={state.decision.payment_date ?? ''} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="dividend-paid-amount">Belopp</Label>
                  <Input id="dividend-paid-amount" name="amount" type="number" min="0.01" step="0.01" required defaultValue={remaining} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="dividend-cash-account">Konto</Label>
                  <Input id="dividend-cash-account" name="cash_account" defaultValue="1930" pattern="19[0-9]{2}" />
                </div>
                <div className="flex items-end justify-end">
                  <Button disabled={busy} type="submit">Bokför utbetalning</Button>
                </div>
              </form>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
