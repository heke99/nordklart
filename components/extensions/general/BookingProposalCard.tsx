'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { formatCurrency } from '@/lib/utils'
import {
  applySuggestion,
  quickApproveBlockers,
  type AccountSuggestion,
  type ProposalLineInput,
  type QuickApproveBlocker,
} from '@/lib/supplier-invoices/booking-proposal'
import type { InvoiceExtractionResult, VatTreatment } from '@/types'

const BLOCKER_TEXT: Record<QuickApproveBlocker, string> = {
  incomplete_accounts: 'Konto saknas för minst en rad – välj konto under Redigera.',
  missing_invoice_number: 'Fakturanummer saknas.',
  missing_dates: 'Fakturadatum eller förfallodatum saknas.',
  foreign_supplier: 'Utländsk leverantör: omvänd skattskyldighet behöver anges under Redigera.',
  foreign_currency: 'Fakturan är i utländsk valuta: kontrollera kursen under Redigera.',
  representation: 'Representation: ange antal deltagare under Redigera (momsavdraget är begränsat).',
  totals_mismatch: 'Raderna summerar inte till fakturans totalbelopp – kontrollera under Redigera.',
}

const SOURCE_TEXT = {
  history: 'Som tidigare fakturor från leverantören',
  history_any_rate: 'Leverantörens vanligaste konto',
  supplier_default: 'Leverantörens standardkonto',
} as const

/** Lines to book: one per VAT rate when the document has a VAT breakdown, else its lines. */
function proposalLines(data: InvoiceExtractionResult, supplierName: string): ProposalLineInput[] {
  const label = [supplierName, data.invoice?.invoiceNumber ? `faktura ${data.invoice.invoiceNumber}` : null]
    .filter(Boolean)
    .join(' – ')
  if (data.vatBreakdown && data.vatBreakdown.length > 0) {
    return data.vatBreakdown.map((row) => ({
      description: data.vatBreakdown.length > 1 ? `${label} (${row.rate} % moms)` : label,
      amount: row.base,
      vatRate: row.rate / 100,
    }))
  }
  return (data.lineItems ?? []).map((li) => ({
    description: li.description || label,
    amount: li.lineTotal,
    vatRate: (li.vatRate ?? 25) / 100,
  }))
}

function vatTreatmentFor(rates: number[]): VatTreatment {
  const unique = new Set(rates)
  if (unique.size === 1) {
    const rate = rates[0]
    if (rate === 0.25) return 'standard_25'
    if (rate === 0.12) return 'reduced_12'
    if (rate === 0.06) return 'reduced_6'
    if (rate === 0) return 'exempt'
  }
  return 'standard_25'
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Booking proposal for an inbox invoice whose supplier is known: the
 * accounts it would be booked on, with "Godkänn" to register it as proposed
 * and "Redigera" to open the full form prefilled with the same proposal.
 */
export default function BookingProposalCard({
  itemId,
  supplierId,
  data,
  onRegistered,
}: {
  itemId: string
  supplierId: string
  data: InvoiceExtractionResult
  onRegistered: () => void
}) {
  const { toast } = useToast()
  const { company, canWrite } = useCompany()
  const [suggestion, setSuggestion] = useState<AccountSuggestion | null>(null)
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/supplier-invoices/booking-proposal?supplier_id=${supplierId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled) setSuggestion(json?.data ?? null)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [supplierId])

  const view = useMemo(() => {
    if (!suggestion) return null
    const supplierName = suggestion.supplier?.name ?? data.supplier?.name ?? ''
    const lines = applySuggestion(proposalLines(data, supplierName), suggestion)
    const invoiceDate = data.invoice?.invoiceDate ?? null
    const terms = suggestion.supplier?.defaultPaymentTerms
    const dueDate = data.invoice?.dueDate ?? (invoiceDate && terms != null ? addDays(invoiceDate, terms) : null)
    const blockers = quickApproveBlockers({
      lines,
      supplierType: suggestion.supplier?.supplierType ?? null,
      currency: data.invoice?.currency ?? 'SEK',
      invoiceNumber: data.invoice?.invoiceNumber ?? null,
      invoiceDate,
      dueDate,
      extractedTotal: data.totals?.total ?? null,
    })
    return { lines, invoiceDate, dueDate, blockers }
  }, [suggestion, data])

  if (loading || !view || view.lines.length === 0) return null

  async function approve() {
    if (!view || view.blockers.length > 0) return
    setApproving(true)
    try {
      const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${itemId}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier_id: supplierId,
          supplier_invoice_number: data.invoice?.invoiceNumber,
          invoice_date: view.invoiceDate,
          due_date: view.dueDate,
          currency: 'SEK',
          vat_treatment: vatTreatmentFor(view.lines.map((l) => l.vatRate)),
          reverse_charge: false,
          payment_reference: data.invoice?.paymentReference || undefined,
          items: view.lines.map((l) => ({
            description: l.description,
            amount: l.amount,
            account_number: l.accountNumber,
            vat_rate: l.vatRate,
          })),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof body.error === 'string' ? body.error : body.error?.message
        toast({
          title: 'Kunde inte registrera fakturan',
          description: message ?? 'Öppna Redigera och kontrollera uppgifterna.',
          variant: 'destructive',
        })
        return
      }
      // Sole traders approve for payment in the same step, as in the form.
      if (company?.entity_type === 'enskild_firma' && body.data?.id) {
        await fetch(`/api/supplier-invoices/${body.data.id}/approve`, { method: 'POST' }).catch(() => undefined)
      }
      toast({
        title: 'Fakturan är registrerad',
        description: body.data?.arrival_number ? `Ankomstnummer ${body.data.arrival_number}` : undefined,
      })
      onRegistered()
    } finally {
      setApproving(false)
    }
  }

  const canApprove = canWrite && view.blockers.length === 0
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <p className="text-sm font-medium">Bokföringsförslag</p>
      <ul className="space-y-2 text-sm">
        {view.lines.map((line, i) => (
          <li key={i} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate">{line.description}</p>
              <p className="text-xs text-muted-foreground">
                {line.accountNumber ? `Konto ${line.accountNumber}` : 'Konto saknas'}
                {line.source ? ` · ${SOURCE_TEXT[line.source]}` : ''}
                {` · moms ${Math.round(line.vatRate * 100)} %`}
              </p>
            </div>
            <span className="tabular-nums shrink-0">{formatCurrency(line.amount)}</span>
          </li>
        ))}
      </ul>
      {view.blockers.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {view.blockers.map((b) => <li key={b}>{BLOCKER_TEXT[b]}</li>)}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          Godkänn registrerar fakturan med kontona ovan. Välj Redigera för att ändra konto, moms eller rader.
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={approve} disabled={!canApprove || approving}>
          {approving ? 'Registrerar…' : 'Godkänn'}
        </Button>
        <Link href={`/supplier-invoices/new?inbox_item_id=${itemId}`} className="flex-1">
          <Button size="sm" variant="outline" className="w-full">Redigera</Button>
        </Link>
      </div>
    </div>
  )
}
