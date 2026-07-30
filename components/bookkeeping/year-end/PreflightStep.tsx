'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react'
import Link from 'next/link'
import type { BokslutReadinessReport } from '@/lib/bokslut/readiness-aggregator'
import {
  historicalWorkpaperSourceLabel,
  historicalWorkpaperStatusLabel,
  isAccountingErrorStatus,
  isCompletedStatus,
  isConfirmationStatus,
} from '@/lib/bokslut/historical-workpapers'

interface PreflightStepProps {
  report: BokslutReadinessReport | null
  isLoading: boolean
  error: string | null
  onContinue: () => void
}

export function PreflightStep({ report, isLoading, error, onContinue }: PreflightStepProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-destructive">{error}</p>
        </CardContent>
      </Card>
    )
  }

  if (!report) {
    return null
  }

  const completedControls = report.controls?.filter((control) =>
    isCompletedStatus(control.status),
  ) ?? []
  const confirmationControls = report.controls?.filter((control) =>
    isConfirmationStatus(control.status),
  ) ?? []
  const errorControls = report.controls?.filter((control) =>
    isAccountingErrorStatus(control.status),
  ) ?? []

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle className="text-base">{report.period.name}</CardTitle>
              <p className="text-sm text-muted-foreground tabular-nums">
                {report.period.period_start} – {report.period.period_end}
              </p>
            </div>
            {report.ready ? (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> Redo för bokslut
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1">
                <XCircle className="h-3.5 w-3.5" /> Inte redo
              </Badge>
            )}
          </div>
        </CardHeader>
      </Card>

      {report.blockers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <XCircle className="h-4 w-4 text-destructive" />
              Måste åtgärdas innan bokslut
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {report.blockers.map((blocker, i) => (
              <BlockerRow key={i} blocker={blocker} report={report} />
            ))}
          </CardContent>
        </Card>
      )}

      <ControlSection
        title="Klart automatiskt"
        controls={completedControls}
        variant="success"
      />
      <ControlSection
        title="Behöver bekräftas"
        description="Det importerade saldot finns redan i huvudboken. Granska och bekräfta utan att registrera beloppet på nytt."
        controls={confirmationControls}
        variant="warning"
      />
      <ControlSection
        title="Verkliga differenser"
        description="Här finns två jämförbara värden som skiljer sig eller ett faktiskt bokföringsfel."
        controls={errorControls}
        variant="destructive"
      />

      {report.warnings.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning-foreground" />
              Varningar
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {report.warnings.map((warning, i) => (
              <p key={i} className="text-sm">
                {warning}
              </p>
            ))}
          </CardContent>
        </Card>
      )}

      {report.reminders.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              Påminnelser
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {report.reminders.map((reminder) => (
              <div key={reminder.code} className="flex items-start gap-3 text-sm">
                <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-foreground shrink-0" />
                <div className="flex-1">
                  <p>{reminder.message}</p>
                  {reminder.href && (
                    <Link
                      href={reminder.href}
                      className="text-xs text-primary hover:underline"
                    >
                      Öppna
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={onContinue} disabled={!report.ready}>
          Fortsätt
        </Button>
      </div>
    </div>
  )
}

function formatControlAmount(value: number | null): string {
  return value == null
    ? '–'
    : `${new Intl.NumberFormat('sv-SE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)} kr`
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    register_migrated_receivables: 'Registrera historiska kundfakturor',
    verify_external_receivables: 'Verifiera extern kundreskontra',
    register_migrated_payables: 'Registrera historiska leverantörsfakturor',
    verify_external_payables: 'Verifiera extern leverantörsreskontra',
    import_historical_bank_statement: 'Importera historiskt kontoutdrag',
    verify_bank_balance: 'Verifiera banksaldo',
    create_equity_reconciliation: 'Skapa eget-kapitalavstämning',
    verify_equity: 'Verifiera eget kapital',
    verify_tax: 'Verifiera skatt',
    verify_vat: 'Verifiera moms',
    create_company_snapshot: 'Hämta företagsuppgifter',
    confirm_company_snapshot: 'Bekräfta företagssnapshot',
    view_imported_vouchers: 'Visa importerade verifikationer',
    create_correction_voucher: 'Skapa rättelseverifikation',
    approve_profit_disposition: 'Godkänn resultatdisposition',
    accept_sie_balance: 'Bekräfta SIE-saldo',
    verify_external_evidence: 'Verifiera externt underlag',
    adjust_workpaper: 'Ändra bokslutsunderlag',
    resolve_reimport_conflict: 'Lös återimportskonflikt',
  }
  return labels[action] ?? 'Öppna'
}

function ControlSection({
  title,
  description,
  controls,
  variant,
}: {
  title: string
  description?: string
  controls: NonNullable<BokslutReadinessReport['controls']>
  variant: 'success' | 'warning' | 'destructive'
}) {
  if (controls.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </CardHeader>
      <CardContent className="space-y-3">
        {controls.map((control) => (
          <div
            key={control.control_code}
            className="grid gap-3 rounded-md border p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{control.label}</p>
                <Badge variant={variant}>
                  {historicalWorkpaperStatusLabel(control.status)}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{control.message}</p>
              {(control.ledger_balance != null || control.support_balance != null) && (
                <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                  Huvudbok {formatControlAmount(control.ledger_balance)}
                  {' · '}Underlag {formatControlAmount(control.support_balance)}
                  {' · '}Differens {formatControlAmount(control.difference)}
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Källa: {historicalWorkpaperSourceLabel(control.source_type)}
              </p>
            </div>
            {control.available_actions.length > 0 && (
              <Button variant="outline" size="sm" asChild>
                <Link href={control.href}>
                  {actionLabel(control.available_actions[0])}
                </Link>
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

/**
 * Renders a blocker with a contextual action link when we can derive one.
 * Falls back to plain text otherwise.
 */
function BlockerRow({ blocker, report }: { blocker: string; report: BokslutReadinessReport }) {
  let href: string | null = null
  let actionLabel: string | null = null
  const structured = report.blockerDetails.find((detail) => detail.message === blocker)

  if (structured?.href && structured.actionLabel) {
    href = structured.href
    actionLabel = structured.actionLabel
  } else if (/draft journal entries/i.test(blocker) && report.draftCount > 0) {
    href = '/bookkeeping?status=draft'
    actionLabel = 'Visa utkast'
  } else if (/voucher gap/i.test(blocker)) {
    href = '/bookkeeping/voucher-gaps'
    actionLabel = 'Hantera nummerlucka'
  } else if (/trial balance/i.test(blocker)) {
    href = '/reports/trial-balance'
    actionLabel = 'Öppna balansrapport'
  } else if (/continuity/i.test(blocker)) {
    href = '/bookkeeping'
    actionLabel = 'Granska ingående balans'
  }

  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <p className="flex-1">{blocker}</p>
      {href && actionLabel && (
        <Link href={href} className="text-xs text-primary hover:underline shrink-0 mt-0.5">
          {actionLabel}
        </Link>
      )}
    </div>
  )
}
