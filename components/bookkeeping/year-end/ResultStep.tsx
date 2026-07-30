'use client'

import { useCallback, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react'
import Link from 'next/link'
import type { YearEndResult, ContinuityDiscrepancy } from '@/types'
import { formatCurrency } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'

interface ResultStepProps {
  result: YearEndResult
  companyId?: string | null
}

const ORE_TOLERANCE = 0.005
const ACKNOWLEDGEMENT_TEXT =
  'Jag har granskat bokslutet och IB/UB-kontinuiteten ovan, och bekräftar att alla balanskonton stämmer mot föregående periods utgående balans.'

export function ResultStep({ result, companyId }: ResultStepProps) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [savingAcknowledgement, setSavingAcknowledgement] = useState(false)
  const [acknowledgementError, setAcknowledgementError] = useState<string | null>(null)

  const continuity = result.continuity
  const discrepancies = continuity?.discrepancies ?? []
  const acknowledge = useCallback(async () => {
    if (acknowledged || savingAcknowledgement) return
    setSavingAcknowledgement(true)
    setAcknowledgementError(null)
    try {
      const companySuffix = companyId
        ? `?company_id=${encodeURIComponent(companyId)}`
        : ''
      const res = await fetch(
        `/api/bookkeeping/fiscal-periods/${result.closingEntry.fiscal_period_id}/year-end/runs/${result.runId}/acknowledge${companySuffix}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            statement_version: 'ib-ub-review-v1',
            statement_text: ACKNOWLEDGEMENT_TEXT,
            continuity_snapshot: continuity ?? {
              checked_accounts: 0,
              discrepancies: [],
            },
          }),
        },
      )
      const body = await res.json()
      if (!res.ok) {
        setAcknowledgementError(body?.error?.message ?? 'Bekräftelsen kunde inte sparas.')
        return
      }
      setAcknowledged(true)
    } catch {
      setAcknowledgementError('Bekräftelsen kunde inte sparas.')
    } finally {
      setSavingAcknowledgement(false)
    }
  }, [acknowledged, savingAcknowledgement, companyId, result, continuity])

  // If the wizard reached ResultStep, executeYearEndClosing already enforced
  // that no per-account diff exceeded ORE_TOLERANCE — but surface a panel
  // grouped by BAS class so the user can confirm visually before leaving.
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-6 text-center space-y-4">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-success/10">
            <CheckCircle2 className="h-7 w-7 text-success" />
          </div>
          <h2 className="font-display text-2xl">Bokslutet är klart</h2>
          <p className="text-muted-foreground">
            Perioden är stängd och en ny räkenskapsperiod har skapats.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resultat</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ResultRow
            label="Bokslutsverifikation"
            value={formatVoucher(result.closingEntry)}
            href={withCompany(`/bookkeeping/${result.closingEntry.id}`, companyId)}
          />
          {result.revaluationEntry && (
            <ResultRow
              label="Kursrevaluering"
              value={formatVoucher(result.revaluationEntry)}
              href={withCompany(`/bookkeeping/${result.revaluationEntry.id}`, companyId)}
            />
          )}
          <ResultRow
            label="Ingående balanser i ny period"
            value={formatVoucher(result.openingBalanceEntry)}
            href={withCompany(`/bookkeeping/${result.openingBalanceEntry.id}`, companyId)}
          />
          <ResultRow label="Ny räkenskapsperiod" value={result.nextPeriod.name} />
          <ResultRow label="Boksluts-run" value={result.runId} />
          <ResultRow label="Regelversion" value={result.rulesetVersion} />
        </CardContent>
      </Card>

      {continuity && (
        <ContinuityPanel
          discrepancies={discrepancies}
          checkedAccounts={continuity.checked_accounts}
        />
      )}

      <Card>
        <CardContent className="p-6 space-y-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              checked={acknowledged}
              disabled={savingAcknowledgement}
              onCheckedChange={(v) => {
                if (v === true) void acknowledge()
              }}
              className="mt-0.5"
              aria-label="Bekräfta bokslut"
            />
            <span className="text-sm leading-relaxed">
              {ACKNOWLEDGEMENT_TEXT}
            </span>
          </label>
          {savingAcknowledgement && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Sparar bekräftelsen…
            </p>
          )}
          {acknowledgementError && (
            <p className="text-sm text-destructive">{acknowledgementError}</p>
          )}

          <div className="flex flex-col sm:flex-row gap-3 sm:justify-end">
            <Button variant="outline" asChild disabled={!acknowledged}>
              <Link
                href={withCompany('/bookkeeping', companyId)}
                aria-disabled={!acknowledged}
                tabIndex={acknowledged ? undefined : -1}
                className={!acknowledged ? 'pointer-events-none opacity-50' : ''}
              >
                Till bokföringen
              </Link>
            </Button>
            <Button variant="outline" asChild disabled={!acknowledged}>
              <Link
                href={withCompany('/reports', companyId)}
                aria-disabled={!acknowledged}
                tabIndex={acknowledged ? undefined : -1}
                className={!acknowledged ? 'pointer-events-none opacity-50' : ''}
              >
                Generera rapporter
              </Link>
            </Button>
            <Button asChild disabled={!acknowledged}>
              <Link
                href={withCompany(
                  `/bookkeeping/year-end/arsredovisning?period=${result.closingEntry.fiscal_period_id}`,
                  companyId,
                )}
                aria-disabled={!acknowledged}
                tabIndex={acknowledged ? undefined : -1}
                className={!acknowledged ? 'pointer-events-none opacity-50' : ''}
              >
                Skapa årsredovisning
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function withCompany(href: string, companyId?: string | null): string {
  if (!companyId) return href
  return `${href}${href.includes('?') ? '&' : '?'}company_id=${encodeURIComponent(companyId)}`
}

function ResultRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-border last:border-b-0 pb-3 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      {href ? (
        <Link href={href} className="font-medium tabular-nums text-primary hover:underline">
          {value}
        </Link>
      ) : (
        <span className="font-medium tabular-nums">{value}</span>
      )}
    </div>
  )
}

interface ContinuityPanelProps {
  discrepancies: ContinuityDiscrepancy[]
  checkedAccounts: number
}

function ContinuityPanel({ discrepancies, checkedAccounts }: ContinuityPanelProps) {
  const grouped = useMemo(() => {
    const byClass = new Map<number, ContinuityDiscrepancy[]>()
    for (const d of discrepancies) {
      const klass = parseInt(d.account_number[0]) || 0
      if (klass !== 1 && klass !== 2) continue
      const list = byClass.get(klass) ?? []
      list.push(d)
      byClass.set(klass, list)
    }
    return byClass
  }, [discrepancies])

  const hasIssues = discrepancies.some(
    (d) => Math.abs(d.difference) > ORE_TOLERANCE
  )

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">IB/UB-avstämning</CardTitle>
        {hasIssues ? (
          <Badge variant="destructive" className="gap-1">
            <AlertTriangle className="h-3 w-3" />
            Avvikelser
          </Badge>
        ) : (
          <Badge variant="success" className="gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Stämmer
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {checkedAccounts} balanskonto(n) jämförda mellan utgående balans i
          stängd period och ingående balans i ny period.
        </p>

        {discrepancies.length === 0 ? (
          <p className="text-sm">
            Inga avvikelser. Alla balanskonton i klass 1 och 2 matchar inom
            tolerans (±0,005 SEK).
          </p>
        ) : (
          <div className="space-y-6">
            {[1, 2].map((klass) => {
              const rows = grouped.get(klass) ?? []
              if (rows.length === 0) return null
              return (
                <div key={klass}>
                  <h3 className="text-sm font-medium uppercase tracking-wider text-muted-foreground mb-2">
                    Klass {klass} – {klass === 1 ? 'Tillgångar' : 'Skulder & eget kapital'}
                  </h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Konto</TableHead>
                        <TableHead className="text-right">UB (föregående)</TableHead>
                        <TableHead className="text-right">IB (ny period)</TableHead>
                        <TableHead className="text-right">Diff</TableHead>
                        <TableHead className="text-right">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((d) => {
                        const overTol = Math.abs(d.difference) > ORE_TOLERANCE
                        return (
                          <TableRow key={d.account_number}>
                            <TableCell className="font-medium tabular-nums">
                              {d.account_number}
                              <span className="ml-2 font-normal text-muted-foreground">
                                {d.account_name}
                              </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCurrency(d.previous_ub_net)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCurrency(d.current_ib_net)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCurrency(d.difference)}
                            </TableCell>
                            <TableCell className="text-right">
                              {overTol ? (
                                <Badge variant="destructive">Avviker</Badge>
                              ) : (
                                <Badge variant="success">OK</Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
