'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { useToast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatCurrency } from '@/lib/utils'
import { AlertTriangle, Banknote, CheckCircle, Loader2, XCircle } from 'lucide-react'

interface EligibilityIssue {
  code: string
  message_sv: string
}

interface FinancingOffer {
  id: string
  offered_amount: number
  fee_percent: number
  fee_amount: number
  payout_amount: number
  recourse: boolean
  valid_until: string | null
  status: 'open' | 'accepted' | 'declined' | 'expired'
}

interface FinancingApplication {
  id: string
  status: string
  recourse: boolean
  requested_amount: number
  error_message: string | null
  created_at: string
  offers?: FinancingOffer[]
}

interface FinancingState {
  readiness: 'sandbox_ready' | 'requires_agreement'
  readiness_message_sv: string | null
  eligible: boolean
  issues: EligibilityIssue[]
  application: FinancingApplication | null
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  submitted: 'default',
  needs_more_info: 'warning',
  offer_created: 'default',
  accepted: 'default',
  rejected: 'destructive',
  paid_out: 'success',
  settled: 'success',
  recourse: 'warning',
  cancelled: 'secondary',
}

export default function InvoiceFinancingDialog({
  invoiceId,
  open,
  onOpenChange,
  canWrite,
}: {
  invoiceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  canWrite: boolean
}) {
  const t = useTranslations('invoice_financing')
  const { toast } = useToast()

  // state === null while the status fetch is in flight (loading signal).
  const [state, setState] = useState<FinancingState | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/invoices/${invoiceId}/financing`)
    const json = await res.json().catch(() => null)
    if (res.ok && json) setState(json.data as FinancingState)
  }, [invoiceId])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const res = await fetch(`/api/invoices/${invoiceId}/financing`)
      const json = await res.json().catch(() => null)
      if (!cancelled && res.ok && json) setState(json.data as FinancingState)
    })()
    return () => {
      cancelled = true
    }
  }, [open, invoiceId])

  async function apply() {
    setIsSubmitting(true)
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/financing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: t('apply_failed'), description: json?.error, variant: 'destructive' })
      } else {
        toast({ title: t('apply_done'), description: json.data?.message_sv })
      }
      await load()
    } finally {
      setIsSubmitting(false)
    }
  }

  async function act(action: 'accept' | 'cancel') {
    if (!state?.application) return
    setIsSubmitting(true)
    try {
      const res = await fetch(`/api/invoice-financing/${state.application.id}/${action}`, {
        method: 'POST',
      })
      const json = await res.json()
      if (!res.ok) {
        toast({
          title: action === 'accept' ? t('accept_failed') : t('cancel_failed'),
          description: json?.error,
          variant: 'destructive',
        })
      } else {
        toast({
          title: action === 'accept' ? t('accept_done') : t('cancel_done'),
          description: json.data?.message_sv,
        })
      }
      await load()
    } finally {
      setIsSubmitting(false)
    }
  }

  const application = state?.application ?? null
  const openOffer = application?.offers?.find((o) => o.status === 'open') ?? null
  const acceptedOffer = application?.offers?.find((o) => o.status === 'accepted') ?? null
  const isTerminal = application
    ? ['rejected', 'cancelled', 'settled'].includes(application.status)
    : false
  const canApply =
    !!state &&
    state.readiness === 'sandbox_ready' &&
    state.eligible &&
    (!application || isTerminal)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-5 w-5" />
            {t('title')}
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {!state ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {state.readiness === 'requires_agreement' ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p>{state.readiness_message_sv}</p>
              </div>
            ) : null}

            {application && !isTerminal ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{t('application_status')}</span>
                  <Badge variant={STATUS_VARIANT[application.status] ?? 'secondary'}>
                    {t(`status_${application.status}`)}
                  </Badge>
                </div>
                {application.error_message ? (
                  <p className="text-sm text-muted-foreground">{application.error_message}</p>
                ) : null}

                {openOffer ? (
                  <div className="space-y-2 rounded-md border p-3">
                    <p className="text-sm font-medium">{t('offer_title')}</p>
                    <div className="grid grid-cols-2 gap-1 text-sm">
                      <span className="text-muted-foreground">{t('offer_payout')}</span>
                      <span className="text-right font-medium">{formatCurrency(openOffer.payout_amount)}</span>
                      <span className="text-muted-foreground">
                        {t('offer_fee', { percent: openOffer.fee_percent })}
                      </span>
                      <span className="text-right">{formatCurrency(openOffer.fee_amount)}</span>
                      <span className="text-muted-foreground">{t('offer_type')}</span>
                      <span className="text-right">
                        {openOffer.recourse ? t('recourse_label') : t('non_recourse_label')}
                      </span>
                    </div>
                    {openOffer.valid_until ? (
                      <p className="text-xs text-muted-foreground">
                        {t('offer_valid_until', {
                          date: new Date(openOffer.valid_until).toLocaleDateString('sv-SE'),
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {application.status === 'paid_out' && acceptedOffer ? (
                  <div className="flex items-start gap-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm dark:border-green-800 dark:bg-green-950">
                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                    <p>{t('paid_out_info', { amount: formatCurrency(acceptedOffer.payout_amount) })}</p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {!application || isTerminal ? (
              state.eligible ? (
                <div className="flex items-start gap-2 rounded-md border border-green-300 bg-green-50 p-3 text-sm dark:border-green-800 dark:bg-green-950">
                  <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                  <p>{t('eligible_info')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium">{t('not_eligible_title')}</p>
                  <ul className="space-y-1">
                    {state.issues.map((issue) => (
                      <li key={issue.code} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                        {issue.message_sv}
                      </li>
                    ))}
                  </ul>
                </div>
              )
            ) : null}

            {isTerminal && application ? (
              <>
                <Separator />
                <p className="text-xs text-muted-foreground">
                  {t('previous_application', { status: t(`status_${application.status}`) })}
                </p>
              </>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2">
          {application && !isTerminal && application.status !== 'paid_out' ? (
            <Button
              variant="outline"
              onClick={() => act('cancel')}
              disabled={isSubmitting || !canWrite}
            >
              {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('cancel_application')}
            </Button>
          ) : null}
          {openOffer && application?.status === 'offer_created' ? (
            <Button onClick={() => act('accept')} disabled={isSubmitting || !canWrite}>
              {isSubmitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle className="mr-2 h-4 w-4" />
              )}
              {t('accept_offer')}
            </Button>
          ) : null}
          {canApply ? (
            <Button onClick={apply} disabled={isSubmitting || !canWrite}>
              {isSubmitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Banknote className="mr-2 h-4 w-4" />
              )}
              {t('apply_action')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
