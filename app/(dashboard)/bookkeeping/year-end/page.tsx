'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowLeft, CheckCircle2, RefreshCw } from 'lucide-react'
import AgentSparkleButton from '@/components/agent/AgentSparkleButton'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getYearEndApiErrorMessage } from '@/lib/year-end/api-error'
import { getOrCreateYearEndExecutionKey } from '@/lib/year-end/idempotency'
import type {
  FiscalPeriod,
  YearEndCommittedWarning,
  YearEndPreview,
  YearEndResult,
} from '@/types'
import type { BokslutReadinessReport } from '@/lib/bokslut/readiness-aggregator'
import { PreflightStep } from '@/components/bookkeeping/year-end/PreflightStep'
import { DispositionsStep } from '@/components/bookkeeping/year-end/DispositionsStep'
import { AccrualsStep } from '@/components/bookkeeping/year-end/AccrualsStep'
import { PreviewStep } from '@/components/bookkeeping/year-end/PreviewStep'
import { ExecuteStep } from '@/components/bookkeeping/year-end/ExecuteStep'
import { ResultStep } from '@/components/bookkeeping/year-end/ResultStep'

type Step = 'preflight' | 'accruals' | 'dispositions' | 'preview' | 'execute' | 'result'

const STEP_ORDER: Step[] = ['preflight', 'accruals', 'dispositions', 'preview', 'execute', 'result']
const STEP_LABELS: Record<Step, string> = {
  preflight: 'Kontroll',
  accruals: 'Periodiseringar',
  dispositions: 'Dispositioner',
  preview: 'Förhandsgranska',
  execute: 'Verkställ',
  result: 'Klart',
}

interface PeriodOption {
  id: string
  name: string
  period_start: string
  period_end: string
  is_closed: boolean
}

export default function YearEndPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const companyId = searchParams.get('company_id')
  const companySuffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : ''
  const [periodRefresh, setPeriodRefresh] = useState(0)
  const [canCreateFiscalYear, setCanCreateFiscalYear] = useState(false)
  const defaultYear = new Date().getFullYear()
  const [newPeriodName, setNewPeriodName] = useState(String(defaultYear))
  const [newPeriodStart, setNewPeriodStart] = useState(`${defaultYear}-01-01`)
  const [newPeriodEnd, setNewPeriodEnd] = useState(`${defaultYear}-12-31`)
  const [creatingPeriod, setCreatingPeriod] = useState(false)

  // ---- Period selection ----
  const [periods, setPeriods] = useState<PeriodOption[] | null>(null)
  const [periodsError, setPeriodsError] = useState<string | null>(null)
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(
    searchParams.get('period') ?? null,
  )

  // ---- Wizard state ----
  const [step, setStep] = useState<Step>('preflight')
  const [report, setReport] = useState<BokslutReadinessReport | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)
  const [preview, setPreview] = useState<YearEndPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [executing, setExecuting] = useState(false)
  const [executeError, setExecuteError] = useState<string | null>(null)
  const [committedWarning, setCommittedWarning] = useState<string | null>(null)
  const [result, setResult] = useState<YearEndResult | null>(null)

  // ---- Load eligible periods ----
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`/api/bookkeeping/fiscal-periods${companySuffix}`)
        const body = await res.json()
        if (!res.ok) {
          if (!cancelled) {
            setPeriodsError(getYearEndApiErrorMessage(
              body,
              'Kunde inte hämta perioder',
              res.status,
            ))
          }
          return
        }
        const data = (body.periods ?? body.data ?? []) as FiscalPeriod[]
        if (!cancelled) setCanCreateFiscalYear(Boolean(body.canCreateFiscalYear))
        const today = new Date().toISOString().split('T')[0]
        const eligible = data.filter((p) => p.period_end <= today)
        // Oldest first — accountants close in order.
        eligible.sort((a, b) => a.period_start.localeCompare(b.period_start))
        if (cancelled) return
        const selectedIsAllowed = Boolean(
          selectedPeriodId && eligible.some((period) => period.id === selectedPeriodId),
        )
        const nextPeriodId = selectedIsAllowed
          ? selectedPeriodId
          : eligible[0]?.id ?? null
        setPeriods(eligible)
        if (nextPeriodId !== selectedPeriodId) {
          setSelectedPeriodId(nextPeriodId)
          setStep('preflight')
          setReport(null)
          setPreview(null)
          setResult(null)
          setExecuteError(null)
        }
      } catch (error) {
        if (!cancelled) setPeriodsError(getErrorMessage(error))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [companySuffix, periodRefresh, selectedPeriodId])

  // ---- Sync selected period to URL so users can bookmark / share ----
  useEffect(() => {
    if (periods === null) return
    const params = new URLSearchParams(searchParams.toString())
    if (!selectedPeriodId) {
      if (!params.has('period')) return
      params.delete('period')
      const query = params.toString()
      router.replace(query ? `/bookkeeping/year-end?${query}` : '/bookkeeping/year-end', {
        scroll: false,
      })
      return
    }
    if (params.get('period') === selectedPeriodId) return
    params.set('period', selectedPeriodId)
    router.replace(`/bookkeeping/year-end?${params.toString()}`, { scroll: false })
  }, [selectedPeriodId, periods, router, searchParams])

  // ---- Failed year-end runs (B10): surface failed attempts so the user can
  // see what happened and retry through the wizard (the close is atomic and
  // idempotent, so a retry is always safe). ----
  const [failedRuns, setFailedRuns] = useState<
    { id: string; status: string; error_code?: string | null; current_step?: string | null; user_message?: string | null; correlation_id?: string | null; retry_count?: number; retryable?: boolean; error_message: string | null; started_at: string }[]
  >([])
  useEffect(() => {
    if (!selectedPeriodId) return
    let cancelled = false
    const loadRuns = () => {
      void fetch(`/api/bookkeeping/fiscal-periods/${selectedPeriodId}/year-end/runs${companySuffix}`)
        .then(async (res) => {
          if (cancelled || !res.ok) return
          const body = await res.json()
          const runs = (body.data ?? []) as {
            id: string
            status: string
            error_code?: string | null
            current_step?: string | null
            user_message?: string | null
            correlation_id?: string | null
            retry_count?: number
            retryable?: boolean
            error_message: string | null
            started_at: string
          }[]
          setFailedRuns(runs.filter((r) => r.status === 'failed' || r.status === 'recovery_required'))
          const inProgress = runs.some((r) => [
            'created', 'validating', 'locking', 'posting_adjustments',
            'posting_closing_entry', 'creating_next_period',
            'creating_opening_balance', 'verifying_continuity',
            'closing_period', 'committing', 'closing',
          ].includes(r.status))
          if (inProgress) {
            setExecuting(true)
            setStep('execute')
          } else {
            setExecuting(false)
          }
          if (body.committedResult) {
            setExecuting(false)
            setResult(body.committedResult as YearEndResult)
            setCommittedWarning(null)
            setStep('result')
          }
        })
        .catch(() => {
          // Non-blocking enrichment.
        })
    }
    const timer = setTimeout(loadRuns, 0)
    const poller = setInterval(loadRuns, 2_000)
    return () => {
      cancelled = true
      clearTimeout(timer)
      clearInterval(poller)
    }
  }, [selectedPeriodId, companySuffix])

  const loadCommittedResult = useCallback(async (): Promise<boolean> => {
    if (!selectedPeriodId) return false
    try {
      const response = await fetch(
        `/api/bookkeeping/fiscal-periods/${selectedPeriodId}/year-end/runs${companySuffix}`,
      )
      const body = await response.json()
      if (!response.ok) {
        setCommittedWarning(getYearEndApiErrorMessage(
          body,
          'Bokslutet är genomfört, men resultatet kunde inte hämtas.',
          response.status,
        ))
        return false
      }
      if (!body.committedResult) return false
      setResult(body.committedResult as YearEndResult)
      setCommittedWarning(null)
      setStep('result')
      return true
    } catch (error) {
      setCommittedWarning(
        `Bokslutet är genomfört, men resultatet kunde inte hämtas. ${getErrorMessage(error)}`,
      )
      return false
    }
  }, [selectedPeriodId, companySuffix])

  // ---- Fetch readiness report whenever selected period changes ----
  useEffect(() => {
    if (!selectedPeriodId) return
    const selectedPeriod = periods?.find((period) => period.id === selectedPeriodId)
    let cancelled = false
    // Defer to the next macrotask so the synchronous setState calls do not
    // run directly within the effect body.
    const timer = setTimeout(() => {
      if (selectedPeriod?.is_closed) {
        setReport(null)
        setReportError(null)
        setReportLoading(false)
        return
      }
      setReportLoading(true)
      setReportError(null)
      setReport(null)
      fetch(`/api/bookkeeping/fiscal-periods/${selectedPeriodId}/bokslut-readiness${companySuffix}`)
        .then(async (res) => {
          const body = await res.json()
          if (cancelled) return
          if (!res.ok) {
            setReportError(getYearEndApiErrorMessage(
              body,
              'Kunde inte ladda bokslutskontroll',
              res.status,
            ))
            return
          }
          setReport(body.data as BokslutReadinessReport)
        })
        .catch(() => {
          if (!cancelled) setReportError('Kunde inte ladda bokslutskontroll')
        })
        .finally(() => {
          if (!cancelled) setReportLoading(false)
        })
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [selectedPeriodId, companySuffix, periods])

  // ---- Step navigation ----
  const goToPreview = useCallback(async () => {
    if (!selectedPeriodId) return
    setPreviewLoading(true)
    setPreviewError(null)
    setStep('preview')
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${selectedPeriodId}/year-end${companySuffix}`)
      const body = await res.json()
      if (!res.ok) {
        setPreviewError(getYearEndApiErrorMessage(
          body,
          'Kunde inte hämta förhandsgranskning',
          res.status,
        ))
        return
      }
      setPreview(body.data.preview as YearEndPreview)
    } catch (err) {
      setPreviewError(getErrorMessage(err))
    } finally {
      setPreviewLoading(false)
    }
  }, [selectedPeriodId, companySuffix])

  const reportPeriodName = report?.period.name
  const executeYearEnd = useCallback(async () => {
    if (!selectedPeriodId || !preview?.previewId) {
      setExecuteError('Förhandsgranskningen saknar ett giltigt preview-ID. Skapa om förhandsgranskningen.')
      setStep('preview')
      return
    }
    setExecuting(true)
    setExecuteError(null)
    try {
      const idempotencyKey = getOrCreateYearEndExecutionKey(
        window.sessionStorage,
        companyId,
        selectedPeriodId,
        preview.previewId,
      )
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${selectedPeriodId}/year-end${companySuffix}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ preview_id: preview.previewId }),
      })
      const body = await res.json()
      if (!res.ok) {
        // body.error.message is the localized Swedish message picked by
        // the structured-error registry. Do NOT interpolate raw details
        // here — they can contain DB-sourced strings (V2.3 finding).
        setExecuteError(getYearEndApiErrorMessage(
          body,
          'Bokslutet kunde inte verkställas',
          res.status,
        ))
        if ([
          'YE_PREVIEW_NOT_FOUND',
          'YE_PREVIEW_STALE',
          'YE_PREVIEW_ALREADY_EXECUTED',
          'YE_LEDGER_CHANGED',
          'YE_READINESS_CHANGED',
          'YE_ADJUSTMENTS_CHANGED',
        ].includes(body?.error?.code)) {
          setPreview(null)
          // Return to the final editable step. Moving to preview with a cleared
          // payload rendered an empty screen and could not generate a fresh ID.
          setStep('dispositions')
        }
        return
      }
      const executionResult = body.data as YearEndResult | YearEndCommittedWarning
      if (executionResult.resultViewComplete === false) {
        setCommittedWarning(executionResult.warning.message)
        setStep('execute')
        toast({
          title: 'Bokslut verkställt',
          description: executionResult.warning.message,
        })
        await loadCommittedResult()
        return
      }
      setResult(executionResult)
      setCommittedWarning(null)
      setStep('result')
      toast({
        title: 'Bokslut verkställt',
        description: `${reportPeriodName ?? 'Perioden'} är stängd.`,
      })
    } catch (err) {
      setExecuteError(getErrorMessage(err))
    } finally {
      setExecuting(false)
    }
  }, [
    selectedPeriodId,
    preview,
    reportPeriodName,
    toast,
    companySuffix,
    companyId,
    loadCommittedResult,
  ])

  const createFiscalYear = useCallback(async () => {
    setCreatingPeriod(true)
    setPeriodsError(null)
    try {
      const res = await fetch(`/api/bookkeeping/fiscal-periods${companySuffix}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: newPeriodName,
          period_start: newPeriodStart,
          period_end: newPeriodEnd,
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setPeriodsError(getYearEndApiErrorMessage(
          body,
          'Räkenskapsåret kunde inte skapas',
          res.status,
        ))
        return
      }
      setSelectedPeriodId(body.data.id)
      setPeriodRefresh((value) => value + 1)
      toast({ title: 'Räkenskapsår skapat', description: `${newPeriodStart} – ${newPeriodEnd}` })
    } catch (error) {
      setPeriodsError(getErrorMessage(error))
    } finally {
      setCreatingPeriod(false)
    }
  }, [companySuffix, newPeriodName, newPeriodStart, newPeriodEnd, toast])

  const currentStepIndex = STEP_ORDER.indexOf(step)
  const progressValue = ((currentStepIndex + 1) / STEP_ORDER.length) * 100

  const showWizard = useMemo(
    () => selectedPeriodId !== null && (periods?.length ?? 0) > 0,
    [selectedPeriodId, periods],
  )

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="font-display text-3xl md:text-4xl tracking-tight">Årsbokslut</h1>
        <div className="flex gap-2">
          <AgentSparkleButton
            intentId="bokslut.step"
            intentArgs={{ step_id: null }}
            contextRef="bokslut:overview"
            size="default"
          />
          <Button variant="outline" asChild>
            <Link href={`/bookkeeping${companySuffix}`}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Bokföring
            </Link>
          </Button>
        </div>
      </div>

      {periods === null && !periodsError && (
        <Card>
          <CardContent className="p-6 space-y-2">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
      )}

      {periodsError && (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-6">
            <div><p className="font-medium text-destructive">{periodsError}</p><p className="mt-1 text-xs text-muted-foreground">Försök igen. Felet visas aldrig som ett tomt eller nollställt resultat.</p></div>
            <Button variant="outline" onClick={() => setPeriodRefresh((value) => value + 1)}><RefreshCw className="mr-2 h-4 w-4" />Försök igen</Button>
          </CardContent>
        </Card>
      )}

      {periods !== null && periods.length === 0 && (
        <Card>
          <CardContent className="space-y-4 p-6">
            <div><h2 className="text-lg font-semibold">Företaget saknar ett bokslutsbart räkenskapsår</h2><p className="mt-1 text-sm text-muted-foreground">Ett tomt resultat är inte ett databasfel. Skapa kalenderår eller ange ett brutet räkenskapsår nedan.</p></div>
            {canCreateFiscalYear ? <div className="grid gap-3 md:grid-cols-4">
              <input value={newPeriodName} onChange={(event) => setNewPeriodName(event.target.value)} aria-label="Namn på räkenskapsår" className="h-10 rounded-md border bg-background px-3 text-sm" />
              <input type="date" value={newPeriodStart} onChange={(event) => setNewPeriodStart(event.target.value)} aria-label="Räkenskapsårets start" className="h-10 rounded-md border bg-background px-3 text-sm" />
              <input type="date" value={newPeriodEnd} onChange={(event) => setNewPeriodEnd(event.target.value)} aria-label="Räkenskapsårets slut" className="h-10 rounded-md border bg-background px-3 text-sm" />
              <Button onClick={createFiscalYear} disabled={creatingPeriod}>{creatingPeriod ? 'Skapar…' : 'Skapa räkenskapsår'}</Button>
            </div> : <p className="text-sm text-muted-foreground">Du saknar rätt att skapa år eller så är engångsköpet inte aktivt.</p>}
          </CardContent>
        </Card>
      )}

      {showWizard && periods && periods.length > 1 && step !== 'result' && (
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <label className="text-sm font-medium shrink-0">Period</label>
            <Select
              value={selectedPeriodId ?? undefined}
              onValueChange={(value) => {
                setSelectedPeriodId(value)
                setStep('preflight')
                setPreview(null)
                setResult(null)
                setExecuteError(null)
                setCommittedWarning(null)
              }}
            >
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {periods.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} ({p.period_start} – {p.period_end}){p.is_closed ? ' · stängd' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      )}

      {showWizard && step !== 'result' && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="sm:hidden text-primary font-medium">
                Steg {currentStepIndex + 1}/{STEP_ORDER.length}: {STEP_LABELS[step]}
              </span>
              {STEP_ORDER.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'hidden sm:inline',
                    i <= currentStepIndex ? 'text-primary font-medium' : 'text-muted-foreground',
                  )}
                >
                  {STEP_LABELS[s]}
                </span>
              ))}
            </div>
            <Progress value={progressValue} className="h-2" />
          </CardContent>
        </Card>
      )}

      {showWizard && step === 'preflight' && failedRuns.length > 0 && (
        <Card className="border-destructive/50">
          <CardContent className="p-4 text-sm">
            <p className="font-medium text-destructive">
              {failedRuns.length} tidigare bokslutsförsök misslyckades
            </p>
            <p className="text-muted-foreground mt-1">
              Bokslutet är atomiskt — ett misslyckat försök lämnar inga halvfärdiga
              poster. Åtgärda felet nedan och kör om guiden.
            </p>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {failedRuns.slice(0, 3).map((run) => (
                <li key={run.id}>
                  {new Date(run.started_at).toLocaleString('sv-SE')}:{' '}
                  {run.user_message ?? run.error_message ?? 'Okänt fel'} {run.error_code ? `(${run.error_code})` : ''}
                  {run.correlation_id ? ` · request-ID ${run.correlation_id}` : ''}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {showWizard && step === 'preflight' && (
        <PreflightStep
          report={report}
          isLoading={reportLoading}
          error={reportError}
          onContinue={() => setStep('accruals')}
        />
      )}

      {showWizard && step === 'accruals' && selectedPeriodId && (
        <AccrualsStep
          periodId={selectedPeriodId}
          companyId={companyId}
          onBack={() => setStep('preflight')}
          onContinue={() => setStep('dispositions')}
        />
      )}

      {showWizard && step === 'dispositions' && selectedPeriodId && (
        <DispositionsStep
          periodId={selectedPeriodId}
          companyId={companyId}
          onBack={() => setStep('accruals')}
          onContinue={goToPreview}
        />
      )}

      {showWizard && step === 'preview' && (
        <PreviewStep
          preview={preview}
          isLoading={previewLoading}
          error={previewError}
          onBack={() => setStep('dispositions')}
          onContinue={() => setStep('execute')}
        />
      )}

      {showWizard && step === 'execute' && committedWarning && (
        <Card>
          <CardContent className="space-y-4 p-6">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-success" />
              <div>
                <p className="font-medium">Bokslutet är genomfört</p>
                <p className="mt-1 text-sm text-muted-foreground">{committedWarning}</p>
              </div>
            </div>
            <Button variant="outline" onClick={() => void loadCommittedResult()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Ladda resultatet igen
            </Button>
          </CardContent>
        </Card>
      )}

      {showWizard && step === 'execute' && report && !committedWarning && (
        <ExecuteStep
          periodName={report.period.name}
          isRunning={executing}
          error={executeError}
          onBack={() => setStep('preview')}
          onExecute={executeYearEnd}
        />
      )}

      {step === 'result' && result && <ResultStep result={result} companyId={companyId} />}
    </div>
  )
}
