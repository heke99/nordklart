'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import {
  RecurringScheduleForm,
  emptyRecurringItem,
  toRecurringRequestBody,
  type RecurringFormValues,
} from '@/components/invoices/RecurringScheduleForm'

const DEFAULTS: RecurringFormValues = {
  name: '',
  customer_id: '',
  currency: 'SEK',
  day_of_month: 25,
  interval_months: 1,
  billing_timing: 'current_period',
  first_run_date: '',
  payment_terms_days: 30,
  end_date: '',
  max_occurrences: null,
  auto_send: false,
  your_reference: '',
  our_reference: '',
  notes: '',
  items: [{ ...emptyRecurringItem }],
}

export default function NewRecurringSchedulePage() {
  const router = useRouter()
  const { toast } = useToast()
  const { company } = useCompany()
  const t = useTranslations('invoice_recurring_new')
  const tForm = useTranslations('invoice_recurring_form')
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(values: RecurringFormValues) {
    if (!values.customer_id) {
      toast({ title: tForm('validation_customer_required'), variant: 'destructive' })
      return
    }
    setIsSubmitting(true)
    try {
      const res = await fetch('/api/invoices/recurring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toRecurringRequestBody(values, 'create')),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(typeof body.error === 'string' ? body.error : body.error?.message || t('create_failed_fallback'))
      }
      toast({ title: t('created_title') })
      router.push('/invoices/recurring')
    } catch (err) {
      toast({
        title: t('create_failed_title'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="space-y-8">
      <Link
        href="/invoices/recurring"
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        {t('back')}
      </Link>

      <PageHeader title={t('title')} />

      <RecurringScheduleForm
        mode="create"
        companyId={company?.id ?? null}
        defaultValues={DEFAULTS}
        submitting={isSubmitting}
        submitLabel={t('create_schedule')}
        onSubmit={onSubmit}
        onCancel={() => router.push('/invoices/recurring')}
      />
    </div>
  )
}
