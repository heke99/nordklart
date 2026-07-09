'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useForm, useFieldArray, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import { AlertTriangle, ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react'
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

  const schema = useMemo(() => {
    const itemSchema = z.object({
      description: z.string().min(1, t('validation_description_required')),
      quantity: z.number().min(0.01, t('validation_quantity_min')),
      unit: z.string().min(1),
      unit_price: z.number(),
      vat_rate: z
        .union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)])
        .nullable()
        .optional(),
    })
    return z.object({
      name: z.string().min(1, t('validation_name_required')),
      day_of_month: z.number().int().min(1).max(31),
      payment_terms_days: z.number().int().min(0).max(90),
      auto_send: z.boolean(),
      your_reference: z.string().optional(),
      our_reference: z.string().optional(),
      notes: z.string().optional(),
      items: z.array(itemSchema).min(1, t('validation_min_one_row')),
    })
  }, [t])

  type FormData = z.infer<typeof schema>

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) })
  const { fields, append, remove } = useFieldArray({ control, name: 'items' })

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
      reset({
        name: json.data.name,
        day_of_month: json.data.day_of_month,
        payment_terms_days: json.data.payment_terms_days,
        auto_send: json.data.auto_send,
        your_reference: json.data.your_reference ?? '',
        our_reference: json.data.our_reference ?? '',
        notes: json.data.notes ?? '',
        items: (json.data.items ?? [])
          .slice()
          .sort((a: RecurringInvoiceScheduleItem, b: RecurringInvoiceScheduleItem) => a.sort_order - b.sort_order)
          .map((it: RecurringInvoiceScheduleItem) => ({
            description: it.description,
            quantity: Number(it.quantity),
            unit: it.unit,
            unit_price: Number(it.unit_price),
            vat_rate: it.vat_rate === null ? null : (Number(it.vat_rate) as 0 | 6 | 12 | 25),
          })),
      })
    } catch {
      toast({ title: tList('load_failed_title'), variant: 'destructive' })
    } finally {
      setIsLoading(false)
    }
  }, [params.id, reset, toast, tList])

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

  async function onSave(data: FormData) {
    if (!schedule) return
    setIsSubmitting(true)
    try {
      const res = await fetch(`/api/invoices/recurring/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
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
            <p className="text-xs text-muted-foreground">{t('day_of_month_hint', { day: schedule.day_of_month })}</p>
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
          </dl>
          {schedule.auto_send && !schedule.customer?.email ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-warning-foreground">
              <AlertTriangle className="h-4 w-4" />
              {t('auto_send_missing_email_warning')}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {isEditing && canWrite ? (
        <form onSubmit={handleSubmit(onSave)}>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('edit_card_title')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="name">{t('name_label')}</Label>
                <Input id="name" {...register('name')} />
                {errors.name && <p className="mt-1 text-sm text-destructive">{errors.name.message}</p>}
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="day_of_month">{t('day_label')}</Label>
                  <Input id="day_of_month" type="number" min={1} max={31} className="tabular-nums" {...register('day_of_month', { valueAsNumber: true })} />
                </div>
                <div>
                  <Label htmlFor="payment_terms_days">{t('payment_terms_label')}</Label>
                  <Input id="payment_terms_days" type="number" min={0} max={90} className="tabular-nums" {...register('payment_terms_days', { valueAsNumber: true })} />
                </div>
              </div>
              <div className="rounded-lg border border-border p-4">
                <div className="flex items-start gap-3">
                  <Controller
                    control={control}
                    name="auto_send"
                    render={({ field }) => (
                      <input
                        type="checkbox"
                        id="auto_send"
                        checked={field.value ?? false}
                        onChange={(e) => field.onChange(e.target.checked)}
                        className="mt-1 h-4 w-4"
                      />
                    )}
                  />
                  <div className="flex-1">
                    <Label htmlFor="auto_send" className="font-medium">{t('auto_send_label')}</Label>
                    <p className="mt-1 text-sm text-muted-foreground">{t('auto_send_description')}</p>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <Label>{t('items_label')}</Label>
                {fields.map((field, index) => (
                  <div key={field.id} className="grid grid-cols-12 items-start gap-2">
                    <div className="col-span-12 sm:col-span-6">
                      <Input placeholder={t('description_placeholder')} {...register(`items.${index}.description`)} />
                    </div>
                    <div className="col-span-3 sm:col-span-2">
                      <Input type="number" step="0.01" className="tabular-nums" {...register(`items.${index}.quantity`, { valueAsNumber: true })} />
                    </div>
                    <div className="col-span-3 sm:col-span-1">
                      <Input {...register(`items.${index}.unit`)} />
                    </div>
                    <div className="col-span-4 sm:col-span-2">
                      <Input type="number" step="0.01" className="tabular-nums" {...register(`items.${index}.unit_price`, { valueAsNumber: true })} />
                    </div>
                    <div className="col-span-2 sm:col-span-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => fields.length > 1 && remove(index)}
                        aria-label={t('remove_row')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => append({ description: '', quantity: 1, unit: 'st', unit_price: 0, vat_rate: 25 })}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {t('add_row')}
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="your_reference">{t('your_reference_label')}</Label>
                  <Input id="your_reference" {...register('your_reference')} />
                </div>
                <div>
                  <Label htmlFor="our_reference">{t('our_reference_label')}</Label>
                  <Input id="our_reference" {...register('our_reference')} />
                </div>
              </div>
              <div>
                <Label htmlFor="notes">{t('notes_label')}</Label>
                <Textarea id="notes" rows={3} {...register('notes')} />
              </div>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setIsEditing(false)}>
                  {t('cancel')}
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? t('saving') : t('save')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </form>
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
