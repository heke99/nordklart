'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from "@/components/ui/skeleton"
import { FiscalYearSelector } from '@/components/common/FiscalYearSelector'
import { KPIHeroCards } from '@/components/kpi/KPIHeroCards'
import { KPITrendChart } from '@/components/kpi/KPITrendChart'
import { KPIExpenseMixChart } from '@/components/kpi/KPIExpenseMixChart'
import { KPITopSuppliersChart } from '@/components/kpi/KPITopSuppliersChart'
import { KPISettingsDialog } from '@/components/kpi/KPISettingsDialog'
import { getDefaultPreferences } from '@/lib/reports/kpi-definitions'
import type { KPIReport, KPIPreferences } from '@/types'

export default function KpiPage() {
  const t = useTranslations('kpi')
  const [selectedPeriod, setSelectedPeriod] = useState<string>('')
  const [report, setReport] = useState<KPIReport | null>(null)
  const [preferences, setPreferences] = useState<KPIPreferences>(getDefaultPreferences())
  const [isLoadingReport, setIsLoadingReport] = useState(false)
  const [isSavingPrefs, setIsSavingPrefs] = useState(false)
  const [error, setError] = useState<{ message: string; code?: string; requestId?: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/kpi/preferences')
        const { data } = await res.json()
        if (!cancelled && data) setPreferences(data)
      } catch {
        // Silently fall back to defaults
      }
    })()
    return () => { cancelled = true }
  }, [])

  const fetchReport = useCallback(async (periodId: string) => {
    setIsLoadingReport(true)
    setError(null)
    try {
      const res = await fetch(`/api/reports/kpi?period_id=${periodId}`)
      const payload = await res.json().catch(() => ({})) as {
        data?: KPIReport
        error?: string
        code?: string
        request_id?: string
      }
      if (!res.ok || !payload.data) {
        setReport(null)
        setError({
          message: payload.error ?? t('fetch_failed'),
          code: payload.code,
          requestId: payload.request_id,
        })
        return
      }
      setReport(payload.data)
    } catch {
      setReport(null)
      setError({ message: t('fetch_failed') })
    } finally {
      setIsLoadingReport(false)
    }
  }, [t])

  useEffect(() => {
    if (!selectedPeriod) return
    let cancelled = false
    // Defer to the next macrotask so the synchronous setState inside
    // fetchReport does not run directly within the effect body.
    const timer = setTimeout(() => {
      fetchReport(selectedPeriod).then(() => {
        if (cancelled) setReport(null)
      })
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [selectedPeriod, fetchReport])

  async function handleSavePreferences(prefs: KPIPreferences) {
    setIsSavingPrefs(true)
    try {
      const res = await fetch('/api/kpi/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      })
      if (!res.ok) throw new Error()
      const { data } = await res.json()
      setPreferences(data)
      if (selectedPeriod) await fetchReport(selectedPeriod)
    } catch {
      // Silently fail — user can retry
    } finally {
      setIsSavingPrefs(false)
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">{t('title')}</h1>
        <div className="flex gap-2">
          <KPISettingsDialog
            preferences={preferences}
            onSave={handleSavePreferences}
            saving={isSavingPrefs}
          />
        </div>
      </div>

      <FiscalYearSelector
        value={selectedPeriod || null}
        onChange={(id) => setSelectedPeriod(id || '')}
        includeAllOption={false}
        hideFuturePeriods
      />

      {error && (
        <Card>
          <CardContent className="space-y-3 py-8 text-center">
            <p className="font-medium text-destructive">{error.message}</p>
            {error.code && (
              <p className="text-xs text-muted-foreground">Felkod: {error.code}</p>
            )}
            {error.requestId && (
              <p className="text-xs text-muted-foreground">Referens: {error.requestId}</p>
            )}
            {selectedPeriod && (
              <Button type="button" variant="outline" onClick={() => void fetchReport(selectedPeriod)}>
                Försök igen
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {isLoadingReport && <LoadingSkeleton />}

      {!isLoadingReport && !error && report && (
        <>
          <KPIHeroCards report={report} preferences={preferences} />
          {report.months.length > 0 && <KPITrendChart months={report.months} />}
          <div className="grid gap-4 md:grid-cols-2">
            <KPIExpenseMixChart composition={report.expenseComposition} />
            <KPITopSuppliersChart suppliers={report.topSuppliers} />
          </div>
        </>
      )}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <CardContent className="p-6 space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-3 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-56" />
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        {[1, 2].map((i) => (
          <Card key={i}>
            <CardContent className="p-6 space-y-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-40" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
