'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  FileCheck2,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency } from '@/lib/utils'
import type { YearEndCashReconciliationStatus } from '@/lib/bokslut/manual-cash-reconciliation'

type Draft = {
  balance: string
  file: File | null
  submitting: boolean
  error: string | null
}

function accountKey(account: YearEndCashReconciliationStatus): string {
  return account.cash_account_id ?? `fallback:${account.ledger_account}`
}

function appendCompany(path: string, companyId: string | null): string {
  if (!companyId) return path
  return `${path}${path.includes('?') ? '&' : '?'}company_id=${encodeURIComponent(companyId)}`
}

export default function YearEndReconciliationPage() {
  const searchParams = useSearchParams()
  const periodId = searchParams.get('period')
  const companyId = searchParams.get('company_id')
  const { toast } = useToast()

  const [accounts, setAccounts] = useState<YearEndCashReconciliationStatus[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})

  const companySuffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : ''
  const backHref = appendCompany(
    `/bookkeeping/year-end${periodId ? `?period=${encodeURIComponent(periodId)}` : ''}`,
    companyId,
  )

  useEffect(() => {
    if (!periodId) {
      const timer = setTimeout(() => setAccounts([]), 0)
      return () => clearTimeout(timer)
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setLoadError(null)
      fetch(
        `/api/bookkeeping/fiscal-periods/${periodId}/manual-cash-reconciliation${companySuffix}`,
      )
        .then(async (response) => {
          const body = await response.json()
          if (cancelled) return
          if (!response.ok) {
            setLoadError(body?.error?.message ?? 'Avstämningen kunde inte hämtas.')
            setAccounts([])
            return
          }
          const rows = (body.data ?? []) as YearEndCashReconciliationStatus[]
          setAccounts(rows)
          setDrafts((current) => {
            const next = { ...current }
            for (const row of rows) {
              const key = accountKey(row)
              next[key] ??= {
                balance: row.statement_balance == null ? '' : String(row.statement_balance),
                file: null,
                submitting: false,
                error: null,
              }
            }
            return next
          })
        })
        .catch(() => {
          if (!cancelled) {
            setLoadError('Avstämningen kunde inte hämtas.')
            setAccounts([])
          }
        })
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [periodId, companySuffix, refresh])

  const updateDraft = useCallback((key: string, patch: Partial<Draft>) => {
    setDrafts((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? {
          balance: '',
          file: null,
          submitting: false,
          error: null,
        }),
        ...patch,
      },
    }))
  }, [])

  const submit = useCallback(
    async (account: YearEndCashReconciliationStatus) => {
      if (!periodId) return
      const key = accountKey(account)
      const draft = drafts[key]
      if (!draft?.balance.trim() || !draft.file) {
        updateDraft(key, { error: 'Fyll i saldot och välj ett kontoutdrag.' })
        return
      }

      updateDraft(key, { submitting: true, error: null })
      const form = new FormData()
      form.set('statement_balance', draft.balance)
      if (account.cash_account_id) form.set('cash_account_id', account.cash_account_id)
      form.set('file', draft.file)

      try {
        const response = await fetch(
          `/api/bookkeeping/fiscal-periods/${periodId}/manual-cash-reconciliation${companySuffix}`,
          {
            method: 'POST',
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            body: form,
          },
        )
        const body = await response.json()
        if (!response.ok) {
          updateDraft(key, {
            error: body?.error?.message ?? 'Avstämningen kunde inte verifieras.',
          })
          return
        }
        updateDraft(key, { file: null })
        setRefresh((value) => value + 1)
        toast({
          title: 'Saldot är verifierat',
          description: `Konto ${account.ledger_account} stämmer mot huvudboken med 0,00 kr i differens.`,
        })
      } catch {
        updateDraft(key, { error: 'Avstämningen kunde inte verifieras.' })
      } finally {
        updateDraft(key, { submitting: false })
      }
    },
    [companySuffix, drafts, periodId, toast, updateDraft],
  )

  const allReconciled = useMemo(
    () => Boolean(accounts?.length) && accounts!.every((account) => account.is_reconciled),
    [accounts],
  )

  if (!periodId) {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-3xl md:text-4xl tracking-tight">Avstämning inför bokslut</h1>
        <Card>
          <CardContent className="p-6 space-y-3">
            <p>Välj först ett räkenskapsår i bokslutsguiden.</p>
            <Button asChild variant="outline">
              <Link href={backHref}>Till bokslut</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl md:text-4xl tracking-tight">
            Avstämning inför bokslut
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Om bolaget saknar bankkoppling kan du verifiera varje likvidkonto med ett
            kontoutdrag per balansdagen. Nordklart räknar saldot direkt från huvudboken och
            accepterar endast exakt 0,00 kr i differens.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href={backHref}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Tillbaka till bokslut
          </Link>
        </Button>
      </div>

      <Card className={allReconciled ? 'border-success/50' : undefined}>
        <CardContent className="flex items-start gap-3 p-5">
          {allReconciled ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          ) : (
            <FileCheck2 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          )}
          <div>
            <p className="font-medium">
              {allReconciled ? 'Alla likvidkonton är avstämda' : 'Oföränderligt underlag krävs'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Kontoutdraget arkiveras med SHA-256-kontrollsumma. Om en verifikation senare
              ändrar saldot blir verifieringen automatiskt ogiltig och måste göras om.
            </p>
          </div>
        </CardContent>
      </Card>

      {accounts === null && (
        <Card>
          <CardContent className="space-y-3 p-6">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      )}

      {loadError && (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-6">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Försök igen
            </Button>
          </CardContent>
        </Card>
      )}

      {accounts?.map((account) => {
        const key = accountKey(account)
        const draft = drafts[key]
        const stale =
          Boolean(account.reconciliation_id) &&
          (!account.snapshot_current || Boolean(account.invalidated_at))
        const evidenceHref = account.reconciliation_id
          ? appendCompany(
              `/api/bookkeeping/fiscal-periods/${periodId}/manual-cash-reconciliation/${account.reconciliation_id}/evidence`,
              companyId,
            )
          : null

        return (
          <Card key={key}>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">
                    {account.account_name} · {account.ledger_account}
                  </CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Huvudbokssaldo per balansdagen:{' '}
                    <span className="font-medium tabular-nums text-foreground">
                      {formatCurrency(Number(account.ledger_balance))}
                    </span>
                  </p>
                </div>
                {account.is_reconciled ? (
                  <Badge variant="success" className="gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Avstämd
                  </Badge>
                ) : stale ? (
                  <Badge variant="destructive" className="gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Måste verifieras igen
                  </Badge>
                ) : (
                  <Badge variant="outline">Inte avstämd</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {account.reconciliation_mode === 'automated' ? (
                <div className="space-y-3">
                  <p className="text-sm">
                    Kontot har bankdata och ska stämmas av genom den ordinarie bankmatchningen.
                    Manuell verifiering är därför låst.
                  </p>
                  <div className="grid gap-2 text-sm sm:grid-cols-3">
                    <p>Omatchade bankrader: {account.unmatched_transaction_count}</p>
                    <p>Omatchade huvudboksrader: {account.unmatched_gl_line_count}</p>
                    <p>Differens: {formatCurrency(Number(account.difference ?? 0))}</p>
                  </div>
                  <Button asChild variant="outline">
                    <Link href={appendCompany('/reports/bank-reconciliation', companyId)}>
                      Öppna bankavstämning
                    </Link>
                  </Button>
                </div>
              ) : (
                <>
                  {stale && (
                    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      <p>
                        Huvudboken ändrades efter den senaste verifieringen. Ladda upp aktuellt
                        underlag och verifiera saldot igen.
                      </p>
                    </div>
                  )}

                  {account.is_reconciled && (
                    <div className="grid gap-3 text-sm sm:grid-cols-3">
                      <div>
                        <p className="text-muted-foreground">Saldo enligt underlag</p>
                        <p className="font-medium tabular-nums">
                          {formatCurrency(Number(account.statement_balance))}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Differens</p>
                        <p className="font-medium tabular-nums">
                          {formatCurrency(Number(account.difference ?? 0))}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Verifierad</p>
                        <p className="font-medium">
                          {account.verified_at
                            ? new Date(account.verified_at).toLocaleString('sv-SE')
                            : '—'}
                        </p>
                      </div>
                    </div>
                  )}

                  {evidenceHref && account.evidence_file_name && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={evidenceHref} target="_blank" rel="noopener noreferrer">
                        <Download className="mr-2 h-4 w-4" />
                        {account.evidence_file_name}
                      </Link>
                    </Button>
                  )}

                  <div className="grid gap-4 border-t pt-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] md:items-end">
                    <div className="space-y-1.5">
                      <Label htmlFor={`balance-${key}`}>
                        Saldo enligt kontoutdrag ({account.currency})
                      </Label>
                      <Input
                        id={`balance-${key}`}
                        inputMode="decimal"
                        placeholder="0,00"
                        value={draft?.balance ?? ''}
                        onChange={(event) =>
                          updateDraft(key, { balance: event.target.value, error: null })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`file-${key}`}>Kontoutdrag per balansdagen</Label>
                      <Input
                        id={`file-${key}`}
                        type="file"
                        accept="application/pdf,image/jpeg,image/png,image/webp"
                        onChange={(event) =>
                          updateDraft(key, {
                            file: event.target.files?.[0] ?? null,
                            error: null,
                          })
                        }
                      />
                    </div>
                    <Button
                      onClick={() => void submit(account)}
                      disabled={draft?.submitting}
                    >
                      {draft?.submitting ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <FileCheck2 className="mr-2 h-4 w-4" />
                      )}
                      Verifiera
                    </Button>
                  </div>
                  {draft?.error && <p className="text-sm text-destructive">{draft.error}</p>}
                </>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
