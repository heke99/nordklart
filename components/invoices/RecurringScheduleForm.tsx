'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useForm, useFieldArray, Controller, type UseFormReturn } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatCurrency, formatDate } from '@/lib/utils'
import { billingPeriod, formatPeriodSv, nextRunDate, type BillingTiming } from '@/lib/invoices/recurring-period'
import type { Currency, Customer } from '@/types'

const CURRENCIES: Currency[] = ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']
const UNITS = ['st', 'tim', 'dag', 'mån', 'månad', 'km', 'kg']
const INTERVALS = [1, 2, 3, 6, 12] as const
const TIMINGS: BillingTiming[] = ['current_period', 'next_period', 'previous_period']
// '' = the customer's default rate, resolved when the invoice is created.
const VAT_OPTIONS = ['', '25', '12', '6', '0'] as const

interface ArticleOption {
  id: string
  article_number: string | null
  name: string
  unit: string
  price_excl_vat: number
  vat_rate: number
  revenue_account: string | null
}

const optionalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal(''))
const optionalPositiveInt = z.number().int().min(1).max(1200).nullable()

function buildSchema(t: (key: string) => string) {
  const item = z.object({
    article_id: z.string().optional(),
    description: z.string().min(1, t('validation_description_required')).max(500),
    quantity: z.number({ message: t('validation_quantity_min') }).min(0.01, t('validation_quantity_min')),
    unit: z.string().min(1),
    unit_price: z.number({ message: t('validation_price') }),
    vat_rate: z.enum(VAT_OPTIONS),
    revenue_account: z.string().optional(),
    valid_from: optionalDate,
    valid_until: optionalDate,
    remaining_occurrences: optionalPositiveInt,
  }).refine((i) => !i.valid_from || !i.valid_until || i.valid_from <= i.valid_until, {
    message: t('validation_period_order'),
    path: ['valid_until'],
  })
  return z.object({
    name: z.string().min(1, t('validation_name_required')).max(200),
    customer_id: z.string().optional(),
    currency: z.enum(['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']),
    day_of_month: z.number().int().min(1).max(31),
    interval_months: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(6), z.literal(12)]),
    billing_timing: z.enum(['current_period', 'next_period', 'previous_period']),
    first_run_date: optionalDate,
    payment_terms_days: z.number().int().min(0).max(90),
    end_date: optionalDate,
    max_occurrences: optionalPositiveInt,
    auto_send: z.boolean(),
    your_reference: z.string().optional(),
    our_reference: z.string().optional(),
    notes: z.string().optional(),
    items: z.array(item).min(1, t('validation_min_one_row')),
  })
}

export type RecurringFormValues = z.infer<ReturnType<typeof buildSchema>>

export const emptyRecurringItem: RecurringFormValues['items'][number] = {
  article_id: '',
  description: '',
  quantity: 1,
  unit: 'st',
  unit_price: 0,
  vat_rate: '',
  revenue_account: '',
  valid_from: '',
  valid_until: '',
  remaining_occurrences: null,
}

/** Request body for POST/PATCH /api/invoices/recurring from the form values. */
export function toRecurringRequestBody(values: RecurringFormValues, mode: 'create' | 'edit') {
  const body: Record<string, unknown> = {
    name: values.name,
    day_of_month: values.day_of_month,
    interval_months: values.interval_months,
    billing_timing: values.billing_timing,
    payment_terms_days: values.payment_terms_days,
    end_date: values.end_date || null,
    max_occurrences: values.max_occurrences ?? null,
    auto_send: values.auto_send,
    your_reference: values.your_reference || (mode === 'edit' ? null : undefined),
    our_reference: values.our_reference || (mode === 'edit' ? null : undefined),
    notes: values.notes || (mode === 'edit' ? null : undefined),
    items: values.items.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unit: i.unit,
      unit_price: i.unit_price,
      vat_rate: i.vat_rate === '' ? null : Number(i.vat_rate),
      article_id: i.article_id || null,
      revenue_account: i.revenue_account || null,
      valid_from: i.valid_from || null,
      valid_until: i.valid_until || null,
      remaining_occurrences: i.remaining_occurrences ?? null,
    })),
  }
  if (mode === 'create') {
    body.customer_id = values.customer_id
    body.currency = values.currency
    if (values.first_run_date) body.start_date = values.first_run_date
  } else if (values.first_run_date) {
    body.next_run_date = values.first_run_date
  }
  return body
}

interface Props {
  mode: 'create' | 'edit'
  companyId: string | null
  defaultValues: RecurringFormValues
  submitting: boolean
  submitLabel: string
  onSubmit: (values: RecurringFormValues) => void
  onCancel: () => void
}

export function RecurringScheduleForm({ mode, companyId, defaultValues, submitting, submitLabel, onSubmit, onCancel }: Props) {
  const t = useTranslations('invoice_recurring_form')
  const schema = useMemo(() => buildSchema(t), [t])
  const form = useForm<RecurringFormValues>({ resolver: zodResolver(schema), defaultValues })
  const { register, control, handleSubmit, watch, formState: { errors } } = form
  const { fields, append, remove } = useFieldArray({ control, name: 'items' })

  const [customers, setCustomers] = useState<Customer[]>([])
  const [articles, setArticles] = useState<ArticleOption[]>([])
  useEffect(() => {
    if (!companyId) return
    const supabase = createClient()
    if (mode === 'create') {
      supabase.from('customers').select('*').eq('company_id', companyId).order('name')
        .then(({ data }) => setCustomers((data ?? []) as Customer[]))
    }
    supabase
      .from('articles')
      .select('id, article_number, name, unit, price_excl_vat, vat_rate, revenue_account')
      .eq('company_id', companyId)
      .eq('active', true)
      .order('name')
      .then(({ data }) => setArticles((data ?? []) as ArticleOption[]))
  }, [companyId, mode])

  const values = watch()
  const subtotal = values.items.reduce((sum, it) => sum + (it.quantity || 0) * (it.unit_price || 0), 0)

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('schedule_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="name">{t('name_label')}</Label>
            <Input id="name" placeholder={t('name_placeholder')} {...register('name')} />
            {errors.name && <p className="mt-1 text-sm text-destructive">{errors.name.message}</p>}
          </div>

          {mode === 'create' ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <Label htmlFor="customer_id">{t('customer_label')}</Label>
                <Controller
                  control={control}
                  name="customer_id"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="customer_id"><SelectValue placeholder={t('customer_placeholder')} /></SelectTrigger>
                      <SelectContent>
                        {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div>
                <Label htmlFor="currency">{t('currency_label')}</Label>
                <Controller
                  control={control}
                  name="currency"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="currency"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="interval_months">{t('interval_label')}</Label>
              <Controller
                control={control}
                name="interval_months"
                render={({ field }) => (
                  <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                    <SelectTrigger id="interval_months"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {INTERVALS.map((n) => <SelectItem key={n} value={String(n)}>{t(`interval_${n}`)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div>
              <Label htmlFor="day_of_month">{t('day_label')}</Label>
              <Input id="day_of_month" type="number" min={1} max={31} className="tabular-nums" {...register('day_of_month', { valueAsNumber: true })} />
              <p className="mt-1 text-xs text-muted-foreground">{t('day_hint')}</p>
            </div>
            <div>
              <Label htmlFor="billing_timing">{t('timing_label')}</Label>
              <Controller
                control={control}
                name="billing_timing"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="billing_timing"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TIMINGS.map((v) => <SelectItem key={v} value={v}>{t(`timing_${v}`)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div>
              <Label htmlFor="first_run_date">{mode === 'create' ? t('first_run_label') : t('next_run_label')}</Label>
              <Input id="first_run_date" type="date" className="tabular-nums" {...register('first_run_date')} />
              <p className="mt-1 text-xs text-muted-foreground">{t('first_run_hint')}</p>
            </div>
            <div>
              <Label htmlFor="payment_terms_days">{t('payment_terms_label')}</Label>
              <Input id="payment_terms_days" type="number" min={0} max={90} className="tabular-nums" {...register('payment_terms_days', { valueAsNumber: true })} />
            </div>
            <div>
              <Label htmlFor="end_date">{t('end_date_label')}</Label>
              <Input id="end_date" type="date" className="tabular-nums" {...register('end_date')} />
            </div>
            <div>
              <Label htmlFor="max_occurrences">{t('max_occurrences_label')}</Label>
              <Input
                id="max_occurrences"
                type="number"
                min={1}
                className="tabular-nums"
                placeholder={t('unlimited')}
                {...register('max_occurrences', { setValueAs: (v) => (v === '' || v == null ? null : Number(v)) })}
              />
            </div>
          </div>

          <SchedulePreview form={form} />

          <div className="rounded-lg border border-border p-4">
            <div className="flex items-start gap-3">
              <Controller
                control={control}
                name="auto_send"
                render={({ field }) => (
                  <input
                    type="checkbox"
                    id="auto_send"
                    checked={field.value}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('items_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('placeholder_hint')}</p>
          {fields.map((field, index) => (
            <RecurringItemRow
              key={field.id}
              form={form}
              index={index}
              articles={articles}
              canRemove={fields.length > 1}
              onRemove={() => remove(index)}
            />
          ))}
          {errors.items?.message ? <p className="text-sm text-destructive">{errors.items.message}</p> : null}
          <Button type="button" variant="secondary" size="sm" onClick={() => append({ ...emptyRecurringItem })}>
            <Plus className="mr-2 h-4 w-4" />
            {t('add_row')}
          </Button>
          <div className="pt-2 text-sm text-muted-foreground tabular-nums">
            {t('subtotal_ex_vat', { amount: formatCurrency(subtotal, values.currency) })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('other_title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
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
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>{t('cancel')}</Button>
        <Button type="submit" disabled={submitting}>{submitting ? t('saving') : submitLabel}</Button>
      </div>
    </form>
  )
}

/** The next three invoices with the period each covers, so the setup can be checked before saving. */
function SchedulePreview({ form }: { form: UseFormReturn<RecurringFormValues> }) {
  const t = useTranslations('invoice_recurring_form')
  const [day, interval, timing, first, endDate, max] = form.watch([
    'day_of_month', 'interval_months', 'billing_timing', 'first_run_date', 'end_date', 'max_occurrences',
  ])
  const rows = useMemo(() => {
    if (!day || day < 1 || day > 31) return []
    const start = first || defaultFirstRun(day)
    const out: Array<{ date: string; period: string }> = []
    let date = start
    for (let i = 0; i < 3; i++) {
      if (endDate && date > endDate) break
      if (max != null && i >= max) break
      out.push({ date, period: formatPeriodSv(billingPeriod(date, interval, timing)) })
      date = nextRunDate(date, day, interval)
    }
    return out
  }, [day, interval, timing, first, endDate, max])

  if (rows.length === 0) return null
  return (
    <div className="rounded-lg border border-border p-4">
      <p className="text-sm font-medium">{t('preview_title')}</p>
      <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
        {rows.map((r) => (
          <li key={r.date} className="tabular-nums">
            {t('preview_row', { date: formatDate(r.date), period: r.period })}
          </li>
        ))}
      </ul>
    </div>
  )
}

function defaultFirstRun(day: number): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const last = new Date(y, m + 1, 0).getDate()
  const thisMonth = Math.min(day, last)
  if (now.getDate() <= thisMonth) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(thisMonth).padStart(2, '0')}`
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return nextRunDate(`${y}-${pad(m + 1)}-${pad(thisMonth)}`, day, 1)
}

function RecurringItemRow({
  form,
  index,
  articles,
  canRemove,
  onRemove,
}: {
  form: UseFormReturn<RecurringFormValues>
  index: number
  articles: ArticleOption[]
  canRemove: boolean
  onRemove: () => void
}) {
  const t = useTranslations('invoice_recurring_form')
  const { register, control, setValue, watch, formState: { errors } } = form
  const item = watch(`items.${index}`)
  const limited = Boolean(item.valid_from || item.valid_until || item.remaining_occurrences)
  const [open, setOpen] = useState(limited)
  const rowErrors = errors.items?.[index]

  function pickArticle(articleId: string) {
    setValue(`items.${index}.article_id`, articleId === 'none' ? '' : articleId)
    const article = articles.find((a) => a.id === articleId)
    if (!article) return
    setValue(`items.${index}.description`, article.name, { shouldValidate: true })
    setValue(`items.${index}.unit`, article.unit || 'st')
    setValue(`items.${index}.unit_price`, Number(article.price_excl_vat))
    setValue(`items.${index}.vat_rate`, String(article.vat_rate) as RecurringFormValues['items'][number]['vat_rate'])
    setValue(`items.${index}.revenue_account`, article.revenue_account ?? '')
  }

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="grid grid-cols-12 items-start gap-2">
        {articles.length > 0 ? (
          <div className="col-span-12 sm:col-span-3">
            <Select value={item.article_id || 'none'} onValueChange={pickArticle}>
              <SelectTrigger aria-label={t('article_label')}><SelectValue placeholder={t('article_label')} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('no_article')}</SelectItem>
                {articles.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.article_number ? `${a.article_number} · ${a.name}` : a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className={articles.length > 0 ? 'col-span-12 sm:col-span-4' : 'col-span-12 sm:col-span-6'}>
          <Input placeholder={t('description_placeholder')} aria-label={t('description_label')} {...register(`items.${index}.description`)} />
          {rowErrors?.description && <p className="mt-1 text-sm text-destructive">{rowErrors.description.message}</p>}
        </div>
        <div className="col-span-3 sm:col-span-1">
          <Input type="number" step="0.01" aria-label={t('quantity_label')} className="tabular-nums" {...register(`items.${index}.quantity`, { valueAsNumber: true })} />
        </div>
        <div className="col-span-3 sm:col-span-1">
          <Controller
            control={control}
            name={`items.${index}.unit`}
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger aria-label={t('unit_label')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Array.from(new Set([...UNITS, field.value])).map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <div className="col-span-6 sm:col-span-1">
          <Input type="number" step="0.01" aria-label={t('unit_price_label')} className="tabular-nums" {...register(`items.${index}.unit_price`, { valueAsNumber: true })} />
        </div>
        <div className="col-span-6 sm:col-span-1">
          <Controller
            control={control}
            name={`items.${index}.vat_rate`}
            render={({ field }) => (
              <Select value={field.value || 'default'} onValueChange={(v) => field.onChange(v === 'default' ? '' : v)}>
                <SelectTrigger aria-label={t('vat_label')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t('vat_customer_default')}</SelectItem>
                  {VAT_OPTIONS.filter(Boolean).map((v) => <SelectItem key={v} value={v}>{v} %</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <div className="col-span-6 flex justify-end gap-1 sm:col-span-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setOpen((v) => !v)}
            aria-label={t('more_options')}
            aria-expanded={open}
          >
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={() => canRemove && onRemove()} aria-label={t('remove_row')} disabled={!canRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {open ? (
        <div className="grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-3">
          <div>
            <Label htmlFor={`items.${index}.valid_from`} className="text-xs">{t('valid_from_label')}</Label>
            <Input id={`items.${index}.valid_from`} type="date" className="tabular-nums" {...register(`items.${index}.valid_from`)} />
          </div>
          <div>
            <Label htmlFor={`items.${index}.valid_until`} className="text-xs">{t('valid_until_label')}</Label>
            <Input id={`items.${index}.valid_until`} type="date" className="tabular-nums" {...register(`items.${index}.valid_until`)} />
            {rowErrors?.valid_until && <p className="mt-1 text-sm text-destructive">{rowErrors.valid_until.message}</p>}
          </div>
          <div>
            <Label htmlFor={`items.${index}.remaining_occurrences`} className="text-xs">{t('remaining_label')}</Label>
            <Input
              id={`items.${index}.remaining_occurrences`}
              type="number"
              min={1}
              className="tabular-nums"
              placeholder={t('every_invoice')}
              {...register(`items.${index}.remaining_occurrences`, { setValueAs: (v) => (v === '' || v == null ? null : Number(v)) })}
            />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-3">{t('limits_hint')}</p>
        </div>
      ) : null}
    </div>
  )
}
