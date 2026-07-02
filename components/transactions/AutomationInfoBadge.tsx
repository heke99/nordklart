'use client'

import { useState } from 'react'
import { Bot, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatDate } from '@/lib/utils'
import Link from 'next/link'

// Automation transparency badge for transaction rows (Batch 11).
// Renders the automation status (+ confidence) as a small clickable badge;
// clicking opens a dialog that lazily fetches the full decision trail from
// /api/transactions/[id]/automation — decisions with Swedish reason codes,
// linked pending operations and the match log — so users can always answer
// "varför gjorde (inte) automatiken något här?" without leaving the list.

type AutomationStatus =
  | 'not_evaluated'
  | 'auto_booked'
  | 'suggested'
  | 'needs_review'
  | 'ignored'
  | 'failed'

const STATUS_LABEL: Record<AutomationStatus, string> = {
  not_evaluated: 'Ej utvärderad',
  auto_booked: 'Auto-bokförd',
  suggested: 'Föreslagen',
  needs_review: 'Behöver granskas',
  ignored: 'Ignorerad',
  failed: 'Automation misslyckades',
}

const STATUS_VARIANT: Record<AutomationStatus, 'default' | 'secondary' | 'warning' | 'destructive'> = {
  not_evaluated: 'secondary',
  auto_booked: 'default',
  suggested: 'secondary',
  needs_review: 'warning',
  ignored: 'secondary',
  failed: 'destructive',
}

interface DecisionTrail {
  transaction: {
    automation_status: string | null
    automation_confidence: number | null
    booked: boolean
  }
  decisions: Array<{
    id: string
    decision: string
    status: string
    confidence: number | null
    risk_level: string
    decided_at: string
    reasons: Array<{ code: string; explanation_sv: string }>
  }>
  pending_operations: Array<{
    id: string
    title: string
    status: string
    created_at: string
  }>
  match_log: Array<{
    action: string
    confidence: number | null
    method: string | null
    at: string
  }>
}

export function AutomationInfoBadge({
  transactionId,
  status,
  confidence,
  sieOverlap,
}: {
  transactionId: string
  status: AutomationStatus | null | undefined
  confidence: number | null | undefined
  /** True when a completed SIE import overlaps this transaction's period. */
  sieOverlap?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [trail, setTrail] = useState<DecisionTrail | null>(null)
  const [loading, setLoading] = useState(false)

  // Nothing to show for unevaluated rows unless there's an overlap warning.
  if ((!status || status === 'not_evaluated') && !sieOverlap) return null

  async function openTrail() {
    setOpen(true)
    if (trail || loading) return
    setLoading(true)
    try {
      const res = await fetch(`/api/transactions/${transactionId}/automation`)
      const json = await res.json()
      if (res.ok) setTrail(json.data as DecisionTrail)
    } finally {
      setLoading(false)
    }
  }

  const label = status && status !== 'not_evaluated' ? STATUS_LABEL[status] : null
  const variant = status && status !== 'not_evaluated' ? STATUS_VARIANT[status] : 'secondary'

  return (
    <>
      {label ? (
        <button
          type="button"
          onClick={openTrail}
          className="inline-flex items-center"
          aria-label={`Automationsstatus: ${label}. Visa detaljer.`}
        >
          <Badge variant={variant} className="h-4 cursor-pointer gap-1 px-1.5 py-0 text-[10px]">
            <Bot className="h-3 w-3" />
            {label}
            {typeof confidence === 'number' ? ` ${confidence} %` : ''}
          </Badge>
        </button>
      ) : null}
      {sieOverlap ? (
        <Badge variant="warning" className="h-4 gap-1 px-1.5 py-0 text-[10px]">
          SIE-överlapp
        </Badge>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Automationens beslut</DialogTitle>
            <DialogDescription>
              Vad automatiken såg och varför den gjorde som den gjorde.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Hämtar beslutslogg …
            </div>
          ) : trail ? (
            <div className="space-y-4 text-sm">
              {trail.decisions.length === 0 && trail.match_log.length === 0 ? (
                <p className="text-muted-foreground">
                  Ingen automationshistorik finns för den här transaktionen.
                </p>
              ) : null}

              {trail.decisions.map((d) => (
                <div key={d.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{d.decision}</Badge>
                    {typeof d.confidence === 'number' ? (
                      <span className="text-xs text-muted-foreground">
                        Träffsäkerhet {d.confidence} %
                      </span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {formatDate(d.decided_at)}
                    </span>
                  </div>
                  {d.reasons.length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {d.reasons.map((r) => (
                        <li key={r.code} className="flex gap-2 text-xs">
                          <span className="text-muted-foreground">•</span>
                          <span>{r.explanation_sv}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}

              {trail.pending_operations.length > 0 ? (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Väntande åtgärder
                  </p>
                  <ul className="space-y-1">
                    {trail.pending_operations.map((p) => (
                      <li key={p.id} className="text-xs">
                        <Link
                          href={`/pending?operation=${p.id}`}
                          className="underline underline-offset-2"
                        >
                          {p.title}
                        </Link>{' '}
                        <span className="text-muted-foreground">({p.status})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {trail.match_log.length > 0 ? (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Matchningslogg
                  </p>
                  <ul className="space-y-1">
                    {trail.match_log.map((l, i) => (
                      <li key={i} className="text-xs text-muted-foreground">
                        {formatDate(l.at)} — {l.action}
                        {l.method ? ` (${l.method})` : ''}
                        {typeof l.confidence === 'number' ? `, ${l.confidence} %` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">
              Beslutsloggen kunde inte hämtas.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
