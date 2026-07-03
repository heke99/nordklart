import type { CoreEventType } from '@/lib/events/types'

/**
 * SINGLE SOURCE OF TRUTH for the webhook event catalog.
 *
 * Historically three catalogs drifted apart (the delivery handler's set, the
 * registration route's zod enum, and the DB seed catalog). All three now
 * derive from this module:
 *
 *   - `delivered: true` — the event flows through the event bus TODAY and
 *     fans out to webhook_deliveries. This is the honest contract.
 *   - `delivered: false` — subscribable (so integrators don't need to
 *     re-register when delivery ships) but NOT yet emitted; documented as
 *     "planerad" in /docs/api/webhooks.
 *
 * Adding an event or flipping `delivered` is a public-API change — bump
 * API_V1_VERSION and add a changelog entry.
 */

export interface WebhookEventDef {
  type: string
  /** True when the event is emitted on the bus and fans out today. */
  delivered: boolean
  description_sv: string
}

export const WEBHOOK_EVENT_CATALOG: WebhookEventDef[] = [
  // ── Invoicing (AR) ──
  { type: 'invoice.created', delivered: true, description_sv: 'Kundfaktura skapad' },
  { type: 'invoice.sent', delivered: true, description_sv: 'Kundfaktura skickad' },
  { type: 'invoice.paid', delivered: true, description_sv: 'Kundfaktura betald' },
  { type: 'credit_note.created', delivered: true, description_sv: 'Kreditfaktura skapad' },
  { type: 'customer.created', delivered: true, description_sv: 'Kund skapad' },

  // ── Purchases (AP) ──
  { type: 'supplier.created', delivered: true, description_sv: 'Leverantör skapad' },
  { type: 'supplier_invoice.registered', delivered: true, description_sv: 'Leverantörsfaktura registrerad' },
  { type: 'supplier_invoice.approved', delivered: true, description_sv: 'Leverantörsfaktura attesterad' },
  { type: 'supplier_invoice.paid', delivered: true, description_sv: 'Leverantörsfaktura betald' },
  { type: 'supplier_invoice.credited', delivered: true, description_sv: 'Leverantörsfaktura krediterad' },
  { type: 'supplier_invoice.uncredited', delivered: true, description_sv: 'Kreditering ångrad' },

  // ── Bank & transactions ──
  { type: 'transaction.categorized', delivered: true, description_sv: 'Banktransaktion kategoriserad/bokförd' },
  { type: 'transaction.reconciled', delivered: true, description_sv: 'Banktransaktion avstämd mot verifikation' },
  { type: 'transaction.synced', delivered: true, description_sv: 'Banktransaktioner synkade (batch)' },
  { type: 'bank_connection.expired', delivered: true, description_sv: 'PSD2-samtycke har löpt ut' },
  { type: 'bank_sync.completed', delivered: true, description_sv: 'Banksynk slutförd' },
  { type: 'bank_sync.failed', delivered: true, description_sv: 'Banksynk misslyckades' },

  // ── Bookkeeping engine ──
  { type: 'journal_entry.committed', delivered: true, description_sv: 'Verifikation bokförd' },
  { type: 'journal_entry.reversed', delivered: true, description_sv: 'Verifikation vänd (storno)' },
  { type: 'journal_entry.corrected', delivered: true, description_sv: 'Verifikation rättad' },
  { type: 'period.locked', delivered: true, description_sv: 'Period låst' },
  { type: 'period.unlocked', delivered: true, description_sv: 'Period upplåst' },
  { type: 'period.year_closed', delivered: true, description_sv: 'Räkenskapsår stängt' },

  // ── Payroll ──
  { type: 'salary_run.created', delivered: true, description_sv: 'Lönekörning skapad' },
  { type: 'salary_run.approved', delivered: true, description_sv: 'Lönekörning godkänd' },
  { type: 'salary_run.booked', delivered: true, description_sv: 'Lönekörning bokförd' },
  { type: 'agi.generated', delivered: true, description_sv: 'AGI-fil genererad' },

  // ── Documents ──
  { type: 'document.uploaded', delivered: true, description_sv: 'Dokument uppladdat' },
  { type: 'document.extracted', delivered: true, description_sv: 'Dokument AI-tolkat (fält extraherade)' },

  // ── Skatteverket pipeline ──
  { type: 'vat_report.generated', delivered: true, description_sv: 'Momsdeklaration beräknad/validerad' },
  { type: 'tax_submission.waiting_for_signature', delivered: true, description_sv: 'Deklaration väntar på signering hos Skatteverket' },
  { type: 'tax_submission.submitted', delivered: true, description_sv: 'Deklaration inlämnad (signerad)' },
  { type: 'tax_submission.failed', delivered: true, description_sv: 'Deklaration avvisad/fel' },

  // ── Async operations ──
  { type: 'operation.completed', delivered: true, description_sv: 'Långkörande operation slutförd' },
  { type: 'operation.failed', delivered: true, description_sv: 'Långkörande operation misslyckades' },

  // ── Peppol / e-invoicing ──
  { type: 'peppol_invoice.sent', delivered: true, description_sv: 'E-faktura skickad via Peppol' },
  { type: 'peppol_invoice.received', delivered: true, description_sv: 'E-faktura mottagen via Peppol' },

  // ── Invoice financing ──
  { type: 'invoice_financing.offer_created', delivered: true, description_sv: 'Finansieringserbjudande skapat' },
  { type: 'invoice_financing.paid_out', delivered: true, description_sv: 'Fakturafinansiering utbetald' },

  // ── Subscribable but not yet emitted (planerade) ──
  { type: 'company.activated', delivered: false, description_sv: 'Företag aktiverat (planerad)' },
  { type: 'agency.created', delivered: false, description_sv: 'Byrå skapad (planerad)' },
  { type: 'agency.client_added', delivered: false, description_sv: 'Byråklient tillagd (planerad)' },
  { type: 'subscription.started', delivered: false, description_sv: 'Prenumeration startad (planerad)' },
  { type: 'subscription.changed', delivered: false, description_sv: 'Prenumeration ändrad (planerad)' },
  { type: 'one_time_purchase.created', delivered: false, description_sv: 'Engångsköp skapat (planerad)' },
  { type: 'year_end.started', delivered: false, description_sv: 'Bokslut startat (planerad)' },
  { type: 'year_end.ready_for_review', delivered: false, description_sv: 'Bokslut klart för granskning (planerad)' },
  { type: 'year_end.completed', delivered: false, description_sv: 'Bokslut slutfört (planerad)' },
  { type: 'bank_connection.created', delivered: false, description_sv: 'Bankkoppling skapad (planerad)' },
  { type: 'bank_transaction.imported', delivered: false, description_sv: 'Banktransaktion importerad — använd transaction.synced (planerad per-rad)' },
  { type: 'bank_transaction.auto_booked', delivered: false, description_sv: 'Banktransaktion autobokförd — använd transaction.categorized (planerad per-rad)' },
  { type: 'bank_transaction.needs_review', delivered: false, description_sv: 'Banktransaktion kräver granskning (planerad)' },
  { type: 'supplier_invoice.matched', delivered: false, description_sv: 'Leverantörsfaktura matchad mot betalning (planerad)' },
  { type: 'bankgiro_application.submitted', delivered: false, description_sv: 'Bankgiro-ansökan inskickad (planerad)' },
  { type: 'bankgiro_application.approved', delivered: false, description_sv: 'Bankgiro-ansökan godkänd (planerad)' },
  { type: 'bankgiro_application.rejected', delivered: false, description_sv: 'Bankgiro-ansökan avslagen (planerad)' },
  { type: 'payment_provider.activated', delivered: false, description_sv: 'Betalleverantör aktiverad (planerad)' },
]

/** Every event type an integrator may subscribe to. */
export const SUBSCRIBABLE_WEBHOOK_EVENTS: readonly string[] =
  WEBHOOK_EVENT_CATALOG.map((e) => e.type)

/**
 * Events that actually fan out to webhook_deliveries today. Typed against
 * CoreEventType so a catalog entry claiming delivery for a non-existent bus
 * event fails the TypeScript build.
 */
export const DELIVERED_WEBHOOK_EVENTS: ReadonlySet<CoreEventType> = new Set(
  WEBHOOK_EVENT_CATALOG.filter((e) => e.delivered).map((e) => e.type as CoreEventType),
)
