'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowRight, Loader2, Plus, Trash2 } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { getYearEndApiErrorMessage } from '@/lib/year-end/api-error'
import type { AccrualsProposal } from '@/lib/bokslut/accruals/types'

interface AccrualsStepProps {
  periodId: string
  companyId?: string | null
  onBack: () => void
  onContinue: () => void
}

interface AutoState {
  vacation: { accept: boolean }
}

interface ManualEntry {
  id: string
  kind: 'audit_fee' | 'manual_prepaid_expense' | 'manual_accrued_expense'
  amount: string
  description: string
  expenseAccount: string
  prepaidAccount: string
  accruedAccount: string
  liabilityAccount: '2991' | '2992'
  saved?: boolean
}

interface StagedAccrual {
  adjustment_kind: string
  calculation_payload?: {
    request?: Record<string, unknown>
  }
}

type AccrualsResponse = AccrualsProposal & {
  groupTouched?: boolean
  stagedAdjustments?: StagedAccrual[]
}

function makeId() {
  return crypto.randomUUID()
}

export function AccrualsStep({ periodId, companyId, onBack, onContinue }: AccrualsStepProps) {
  const { toast } = useToast()
  const [proposal, setProposal] = useState<AccrualsProposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState<AutoState>({ vacation: { accept: true } })
  const [manual, setManual] = useState<ManualEntry[]>([])
  const [manualErrors, setManualErrors] = useState<Record<string, string>>({})
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Defer to the next macrotask so the synchronous setState does not run
    // directly within the effect body.
    const timer = setTimeout(() => {
      setLoading(true)
      setError(null)
      const companySuffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : ''
      fetch(`/api/bookkeeping/fiscal-periods/${periodId}/accruals${companySuffix}`)
        .then(async (res) => {
          const body = await res.json()
          if (cancelled) return
          if (!res.ok) {
            setError(getYearEndApiErrorMessage(
              body,
              'Kunde inte ladda periodiseringar',
              res.status,
            ))
            return
          }
          const data = body.data as AccrualsResponse
          setProposal(data)
          const staged = data.stagedAdjustments ?? []
          setAuto({
            vacation: {
              accept: data.groupTouched
                ? staged.some((item) => item.adjustment_kind === 'vacation_liability_change')
                : true,
            },
          })
          setManual(staged.flatMap(stagedAccrualToManualEntry))
          setManualErrors({})
        })
        .catch(() => {
          if (!cancelled) setError('Kunde inte ladda periodiseringar')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [periodId, companyId])

  const addManual = useCallback((kind: ManualEntry['kind']) => {
    setManual((prev) => [
      ...prev,
      {
        id: makeId(),
        kind,
        amount: '',
        description: '',
        expenseAccount: kind === 'audit_fee' ? '6420' : '',
        prepaidAccount: '',
        accruedAccount: '',
        liabilityAccount: '2992',
      },
    ])
  }, [])

  const removeManual = useCallback((id: string) => {
    setManual((prev) => prev.filter((m) => m.id !== id))
    setManualErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const updateManual = useCallback((id: string, patch: Partial<ManualEntry>) => {
    setManual((prev) => prev.map((m) => (
      m.id === id ? { ...m, ...patch, saved: false } : m
    )))
    setManualErrors((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  const handleCommit = useCallback(async () => {
    if (!proposal) return
    setPosting(true)
    setError(null)
    try {
      const items: unknown[] = []
      if (proposal.proposals.find((p) => p.kind === 'vacation_liability_change') && auto.vacation.accept) {
        items.push({ kind: 'vacation_liability_change' })
      }
      const validationErrors: Record<string, string> = {}
      for (const m of manual) {
        const amount = parseFloat(m.amount)
        if (!Number.isFinite(amount) || amount <= 0) {
          validationErrors[m.id] = 'Ange ett belopp större än 0.'
          continue
        }
        if (m.kind === 'audit_fee') {
          items.push({ kind: 'audit_fee', amount, liability_account: m.liabilityAccount })
        } else if (m.kind === 'manual_prepaid_expense') {
          if (!m.expenseAccount) validationErrors[m.id] = 'Ange kostnadskonto.'
          else if (!m.prepaidAccount) validationErrors[m.id] = 'Ange ett 17xx-konto.'
          else if (!m.description.trim()) validationErrors[m.id] = 'Ange en beskrivning.'
          if (validationErrors[m.id]) continue
          items.push({
            kind: 'manual_prepaid_expense',
            amount,
            expense_account: m.expenseAccount,
            prepaid_account: m.prepaidAccount,
            description: m.description,
          })
        } else if (m.kind === 'manual_accrued_expense') {
          if (!m.expenseAccount) validationErrors[m.id] = 'Ange kostnadskonto.'
          else if (!m.accruedAccount) validationErrors[m.id] = 'Ange ett 29xx-konto.'
          else if (!m.description.trim()) validationErrors[m.id] = 'Ange en beskrivning.'
          if (validationErrors[m.id]) continue
          items.push({
            kind: 'manual_accrued_expense',
            amount,
            expense_account: m.expenseAccount,
            accrued_account: m.accruedAccount,
            description: m.description,
          })
        }
      }
      if (Object.keys(validationErrors).length > 0) {
        setManualErrors(validationErrors)
        setError('Komplettera de markerade manuella periodiseringarna innan du fortsätter.')
        return
      }
      const companySuffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : ''
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/accruals${companySuffix}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(getYearEndApiErrorMessage(
          body,
          'Kunde inte spara periodiseringarna',
          res.status,
        ))
        return
      }
      const staged = body.data?.staged?.count ?? 0
      toast({
        title: `${staged} periodisering${staged === 1 ? '' : 'ar'} sparad${
          staged === 1 ? '' : 'e'
        }`,
        description: 'Posterna bokförs atomiskt först i steget Verkställ.',
      })
      onContinue()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Okänt fel')
    } finally {
      setPosting(false)
    }
  }, [proposal, auto, manual, periodId, companyId, onContinue, toast])

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-2">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error && !proposal) {
    return (
      <Card>
        <CardContent className="p-6 text-destructive">{error}</CardContent>
      </Card>
    )
  }

  if (!proposal) return null

  const vacation = proposal.proposals.find((p) => p.kind === 'vacation_liability_change')

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Periodiseringar</CardTitle>
          <p className="text-sm text-muted-foreground">
            Förutbetalda kostnader (17xx) och upplupna kostnader (29xx). Posteringarna
            som ska vändas får en beständig reverseringsplan med datum. Ingen
            bokföring sker innan hela bokslutet verkställs.
          </p>
        </CardHeader>
      </Card>

      {vacation && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <CardTitle className="text-base">{vacation.label}</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">{vacation.description}</p>
                {vacation.reverses_on ? (
                  <Badge variant="outline" className="mt-2">
                    Vänds {vacation.reverses_on}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="mt-2">
                    Rullas vidare (ingen vändning)
                  </Badge>
                )}
              </div>
              <p className="font-display text-2xl tabular-nums shrink-0">
                {formatCurrency(vacation.amount)}
              </p>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Checkbox
                id="accept-vacation"
                checked={auto.vacation.accept}
                onCheckedChange={(c) => setAuto({ vacation: { accept: Boolean(c) } })}
              />
              <Label htmlFor="accept-vacation" className="text-sm cursor-pointer select-none">
                Ta med denna justering
              </Label>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Manuella periodiseringar</CardTitle>
          <p className="text-sm text-muted-foreground">
            Lägg till revisionsarvode, hyra som löper över årsskiftet, förutbetalda
            försäkringar m.m.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {manual.length === 0 && (
            <p className="text-sm text-muted-foreground italic">Inga manuella periodiseringar tillagda än.</p>
          )}
          {manual.map((m) => (
            <ManualEntryEditor
              key={m.id}
              entry={m}
              error={manualErrors[m.id]}
              onChange={(patch) => updateManual(m.id, patch)}
              onRemove={() => removeManual(m.id)}
            />
          ))}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => addManual('audit_fee')}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Revisions-/bokslutsarvode
            </Button>
            <Button variant="outline" size="sm" onClick={() => addManual('manual_prepaid_expense')}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Förutbetald kostnad
            </Button>
            <Button variant="outline" size="sm" onClick={() => addManual('manual_accrued_expense')}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Upplupen kostnad
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack} disabled={posting}>
          Tillbaka
        </Button>
        <Button onClick={handleCommit} disabled={posting}>
          {posting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sparar…
            </>
          ) : (
            <>
              Fortsätt <ArrowRight className="ml-1 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

function ManualEntryEditor({
  entry,
  error,
  onChange,
  onRemove,
}: {
  entry: ManualEntry
  error?: string
  onChange: (patch: Partial<ManualEntry>) => void
  onRemove: () => void
}) {
  return (
    <div className={`rounded-md border p-3 space-y-3 ${
      error ? 'border-destructive' : 'border-border'
    }`}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">
          {entry.kind === 'audit_fee' && 'Revisions-/bokslutsarvode'}
          {entry.kind === 'manual_prepaid_expense' && 'Förutbetald kostnad'}
          {entry.kind === 'manual_accrued_expense' && 'Upplupen kostnad'}
        </p>
        {entry.saved && <Badge variant="success">Sparad till bokslutet</Badge>}
        <Button variant="ghost" size="sm" onClick={onRemove} className="h-7 px-2">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Belopp (kr)</Label>
          <Input
            type="number"
            step="1"
            min="0"
            value={entry.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
            className="tabular-nums h-8"
          />
        </div>
        {entry.kind === 'audit_fee' && (
          <div className="space-y-1">
            <Label className="text-xs">Konto</Label>
            <select
              className="border border-border rounded-md h-8 text-sm px-2 w-full bg-background"
              value={entry.liabilityAccount}
              onChange={(e) =>
                onChange({ liabilityAccount: e.target.value as '2991' | '2992' })
              }
            >
              <option value="2992">2992 — Revision</option>
              <option value="2991">2991 — Bokslut</option>
            </select>
          </div>
        )}
        {entry.kind !== 'audit_fee' && (
          <>
            <div className="space-y-1">
              <Label className="text-xs">Kostnadskonto</Label>
              <Input
                value={entry.expenseAccount}
                onChange={(e) => onChange({ expenseAccount: e.target.value })}
                placeholder="t.ex. 6310"
                className="tabular-nums h-8"
              />
            </div>
            {entry.kind === 'manual_prepaid_expense' && (
              <div className="space-y-1">
                <Label className="text-xs">17xx-konto</Label>
                <Input
                  value={entry.prepaidAccount}
                  onChange={(e) => onChange({ prepaidAccount: e.target.value })}
                  placeholder="t.ex. 1730"
                  className="tabular-nums h-8"
                />
              </div>
            )}
            {entry.kind === 'manual_accrued_expense' && (
              <div className="space-y-1">
                <Label className="text-xs">29xx-konto</Label>
                <Input
                  value={entry.accruedAccount}
                  onChange={(e) => onChange({ accruedAccount: e.target.value })}
                  placeholder="t.ex. 2990"
                  className="tabular-nums h-8"
                />
              </div>
            )}
            <div className="space-y-1 col-span-2">
              <Label className="text-xs">Beskrivning</Label>
              <Input
                value={entry.description}
                onChange={(e) => onChange({ description: e.target.value })}
                placeholder="t.ex. Försäkring 2026"
                className="h-8"
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function stagedAccrualToManualEntry(adjustment: StagedAccrual): ManualEntry[] {
  const request = adjustment.calculation_payload?.request
  if (!request) return []
  const kind = request.kind
  if (
    kind !== 'audit_fee'
    && kind !== 'manual_prepaid_expense'
    && kind !== 'manual_accrued_expense'
  ) {
    return []
  }
  const amount = typeof request.amount === 'number' ? String(request.amount) : ''
  return [{
    id: makeId(),
    kind,
    amount,
    description: typeof request.description === 'string' ? request.description : '',
    expenseAccount: typeof request.expense_account === 'string'
      ? request.expense_account
      : kind === 'audit_fee' ? '6420' : '',
    prepaidAccount: typeof request.prepaid_account === 'string' ? request.prepaid_account : '',
    accruedAccount: typeof request.accrued_account === 'string' ? request.accrued_account : '',
    liabilityAccount: request.liability_account === '2991' ? '2991' : '2992',
    saved: true,
  }]
}
