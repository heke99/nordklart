'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate } from '@/lib/utils'
import { AlertTriangle, ArrowLeft, Pencil } from 'lucide-react'
import {
  RecurringScheduleForm,
  toRecurringRequestBody,
  type RecurringFormValues,
} from '@/components/invoices/RecurringScheduleForm'
import { billingPeriod, formatPeriodSv } from '@/lib/invoices/recurring-period'
import type { Customer, RecurringInvoiceSchedule, RecurringInvoiceScheduleItem } from '@/types'

type ScheduleDetail = RecurringInvoiceSchedule & {
  customer?: Customer
  items?: RecurringInvoiceScheduleItem[]
}

type RunRow = {
  id: string
  run_date: string
  status: 'running' | 'succeeded' | 'failed' | 'skipped'
  invoice_id: string | null
  auto_sent: boolean
  warning: string | null
  error: string | null
  started_at: string
  finished_at: string | null
  invoice?: { id: string; invoice_number: string | null; status: string; total: number } | null
}

export default function RecurringScheduleDetailPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const t = useTranslations('invoice_recurring_detail')
  const tList = useTranslations('invoice_recurring')

  const [schedule, setSchedule] = useState<ScheduleDetail | null>(null)
  const [runs, setRuns] = useState<RunRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [formDefaults, setFormDefaults] = useState<RecurringFormValues | null>(null)

  // Note: no synchronous setState here — isLoading starts as true and
  // refreshes reuse the already-rendered data while refetching.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/invoices/recurring/${params.id}`)
      if (res.status === 404) {
        setNotFound(true)
        return
      }
      if (!res.ok) throw new Error('failed')
      const json = await res.json()
      setSchedule(json.data)
      setRuns(json.runs ?? [])
      setFormDefaults(scheduleToFormValues(json.data))
    } catch {
      toast({ title: tList('load_failed_title'), variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [params.id, toast, tList])

  useEffect(() => {
    // Defer to a macrotask so the effect body never touches state
    // synchronously (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => {
      void load()
    }, 0)
    return () => clearTimeout(timer)
  }, [load])

  async function togglePause() {
    if (!schedule) return
    const next = schedule.status === 'active' ? 'paused' : 'active'
    const res = await fetch(`/api/invoices/recurring/${schedule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    })
    if (res.ok) {
      toast({ title: next === 'paused' ? tList('schedule_paused_title') : tList('schedule_resumed_title') })
      load()
    } else {
      toast({ title: tList('schedule_update_failed_title'), variant: 'destructive' })
    }
  }

  async function deleteSchedule() {
    if (!schedule) return
    if (!confirm(tList('delete_confirm', { name: schedule.name }))) return
    const res = await fetch(`/api/invoices/recurring/${schedule.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast({ title: tList('schedule_deleted_title') })
      router.push('/invoices/recurring')
    } else {
      toast({ title: tList('schedule_delete_failed_title'), variant: 'destructive' })
    }
  }

  async function onSave(values: RecurringFormValues) {
    if (!schedule) return
    setIsSubmitting(true)
    try {
      const body = toRecurringRequestBody(values, 'edit')
      // An unchanged next run date is not re-sent.
      if (body.next_run_date === schedule.next_run_date) delete body.next_run_date
      const res = await fetch(`/api/invoices/recurring/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || t('save_failed_fallback'))
      }
      toast({ title: t('saved_title') })
      setIsEditing(false)
      load()
    } catch (err) {
      toast({
        title: t('save_failed_title'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          {tList('loading')}
        </CardContent>
      </Card>
    )
  }

  if (notFound || !schedule) {
    return (
      <div className="space-y-6">
        <Link href="/invoices/recurring" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t('back')}
        </Link>
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t('not_found')}
          </CardContent>
        </Card>
      </div>
    )
  }

  const latestRun = runs[0] ?? null

  return (
    <div className="space-y-8">
      <Link href="/invoices/recurring" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4 mr-1" />
        {t('back')}
      </Link>

      <PageHeader
        title={schedule.name}
        action={
          canWrite ? (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={togglePause}>
                {schedule.status === 'active' ? tList('pause') : tList('resume')}
              </Button>
              <Button variant="outline" onClick={() => setIsEditing((v) => !v)}>
                <Pencil className="mr-2 h-4 w-4" />
                {isEditing ? t('stop_editing') : t('edit')}
              </Button>
              <Button variant="ghost" onClick={deleteSchedule}>
                {tList('delete')}
              </Button>
            </div>
          ) : undefined
        }
      />

      {schedule.last_run_warning ? (
        <div className="flex items-start gap-3 rounded-lg border border-warning bg-warning/10 p-4 text-sm" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground" />
          <div>
            <p className="font-medium">{t('warning_title')}</p>
            <p className="text-muted-foreground">{schedule.last_run_warning}</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('status_label')}</p>
            <div className="mt-1">
              {schedule.status === 'active' ? (
                <Badge variant="success">{tList('status_active')}</Badge>
              ) : schedule.status === 'ended' ? (
                <Badge variant="outline">{t('status_ended')}</Badge>
              ) : (
                <Badge variant="secondary">{tList('status_paused')}</Badge>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('next_run_label')}</p>
            <p className="mt-1 font-medium tabular-nums">{formatDate(schedule.next_run_date)}</p>
            <p className="text-xs text-muted-foreground">
              {t('next_period_hint', {
                period: formatPeriodSv(billingPeriod(schedule.next_run_date, schedule.interval_months ?? 1, schedule.billing_timing ?? 'current_period')),
              })}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('latest_invoice_label')}</p>
            {latestRun?.invoice ? (
              <Link href={`/invoices/${latestRun.invoice.id}`} className="mt-1 block font-medium text-primary hover:underline">
                {latestRun.invoice.invoice_number ?? t('draft_invoice')}
              </Link>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">—</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t('generated_label')}</p>
            <p className="mt-1 font-medium tabular-nums">{schedule.generated_count}</p>
            <p className="text-xs text-muted-foreground">
              {schedule.auto_send ? t('auto_send_on') : t('auto_send_off')}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('details_card_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('customer_label')}</dt>
              <dd className="font-medium">{schedule.customer?.name ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('customer_email_label')}</dt>
              <dd className="font-medium">{schedule.customer?.email ?? t('email_missing')}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('payment_terms_label')}</dt>
              <dd className="font-medium tabular-nums">{t('payment_terms_value', { days: schedule.payment_terms_days })}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('currency_label')}</dt>
              <dd className="font-medium">{schedule.currency}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('cadence_label')}</dt>
              <dd className="font-medium">{t(`cadence_${schedule.interval_months ?? 1}`, { day: schedule.day_of_month })}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('ends_label')}</dt>
              <dd className="font-medium tabular-nums">
                {schedule.end_date
                  ? formatDate(schedule.end_date)
                  : schedule.max_occurrences
                    ? t('ends_after', { count: schedule.max_occurrences })
                    : t('ends_never')}
              </dd>
            </div>
          </dl>
          {schedule.auto_send && !schedule.customer?.email ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-warning-foreground">
              <AlertTriangle className="h-4 w-4" />
              {t('auto_send_missing_email_warning')}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {isEditing && canWrite && formDefaults ? (
        <RecurringScheduleForm
          mode="edit"
          companyId={schedule.company_id}
          defaultValues={formDefaults}
          submitting={isSubmitting}
          submitLabel={t('save')}
          onSubmit={onSave}
          onCancel={() => setIsEditing(false)}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('runs_card_title')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">{t('runs_empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('run_date')}</TableHead>
                  <TableHead>{t('run_status')}</TableHead>
                  <TableHead>{t('run_invoice')}</TableHead>
                  <TableHead>{t('run_sent')}</TableHead>
                  <TableHead>{t('run_message')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="tabular-nums">{formatDate(run.run_date)}</TableCell>
                    <TableCell>
                      {run.status === 'succeeded' ? (
                        <Badge variant="success">{t('run_status_succeeded')}</Badge>
                      ) : run.status === 'failed' ? (
                        <Badge variant="destructive">{t('run_status_failed')}</Badge>
                      ) : run.status === 'running' ? (
                        <Badge variant="secondary">{t('run_status_running')}</Badge>
                      ) : (
                        <Badge variant="secondary">{t('run_status_skipped')}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {run.invoice ? (
                        <Link href={`/invoices/${run.invoice.id}`} className="text-primary hover:underline">
                          {run.invoice.invoice_number ?? t('draft_invoice')}
                          {' '}
                          <span className="tabular-nums text-muted-foreground">
                            ({formatCurrency(run.invoice.total, schedule.currency)})
                          </span>
                        </Link>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>{run.auto_sent ? t('run_sent_yes') : t('run_sent_no')}</TableCell>
                    <TableCell className="max-w-md text-sm text-muted-foreground">
                      {run.error ?? run.warning ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function scheduleToFormValues(data: ScheduleDetail): RecurringFormValues {
  return {
    name: data.name,
    currency: data.currency,
    day_of_month: data.day_of_month,
    interval_months: (data.interval_months ?? 1) as RecurringFormValues['interval_months'],
    billing_timing: data.billing_timing ?? 'current_period',
    first_run_date: data.next_run_date,
    payment_terms_days: data.payment_terms_days,
    end_date: data.end_date ?? '',
    max_occurrences: data.max_occurrences ?? null,
    auto_send: data.auto_send,
    your_reference: data.your_reference ?? '',
    our_reference: data.our_reference ?? '',
    notes: data.notes ?? '',
    items: (data.items ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((it) => ({
        article_id: it.article_id ?? '',
        description: it.description,
        quantity: Number(it.quantity),
        unit: it.unit,
        unit_price: Number(it.unit_price),
        vat_rate: (it.vat_rate == null ? '' : String(Number(it.vat_rate))) as RecurringFormValues['items'][number]['vat_rate'],
        revenue_account: it.revenue_account ?? '',
        valid_from: it.valid_from ?? '',
        valid_until: it.valid_until ?? '',
        remaining_occurrences: it.remaining_occurrences ?? null,
      })),
  }
}
