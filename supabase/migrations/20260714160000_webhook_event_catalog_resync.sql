-- Webhook event catalog resync.
--
-- The DB webhook_events table (used by the platform admin console) drifted
-- from the runtime catalog in lib/webhooks/event-catalog.ts — the single
-- source of truth that drives delivery fan-out, subscription validation and
-- GET /api/v1/companies/:companyId/webhook-events. Old rows used event codes
-- that never existed on the bus (vat_return.submitted, journal_entry.created,
-- company.created, ...).
--
-- This migration marks every non-canonical row 'deprecated' and upserts the
-- canonical catalog (delivered → 'active', planned → 'planned'). The rows
-- below are GENERATED from lib/webhooks/event-catalog.ts — regenerate when
-- the catalog changes (see that module's header).
--
-- pg-test: skip (seed-data resync of an admin-console lookup table; no
-- triggers/RPC/RLS logic changed)

update public.webhook_events
set status = 'deprecated', updated_at = now()
where code not in (
  'invoice.created',
  'invoice.sent',
  'invoice.paid',
  'credit_note.created',
  'customer.created',
  'supplier.created',
  'supplier_invoice.registered',
  'supplier_invoice.approved',
  'supplier_invoice.paid',
  'supplier_invoice.credited',
  'supplier_invoice.uncredited',
  'transaction.categorized',
  'transaction.reconciled',
  'transaction.synced',
  'bank_connection.expired',
  'bank_sync.completed',
  'bank_sync.failed',
  'journal_entry.committed',
  'journal_entry.reversed',
  'journal_entry.corrected',
  'period.locked',
  'period.unlocked',
  'period.year_closed',
  'salary_run.created',
  'salary_run.approved',
  'salary_run.booked',
  'agi.generated',
  'document.uploaded',
  'document.extracted',
  'vat_report.generated',
  'tax_submission.waiting_for_signature',
  'tax_submission.submitted',
  'tax_submission.failed',
  'operation.completed',
  'operation.failed',
  'peppol_invoice.sent',
  'peppol_invoice.received',
  'invoice_financing.offer_created',
  'invoice_financing.paid_out',
  'company.activated',
  'agency.created',
  'agency.client_added',
  'subscription.started',
  'subscription.changed',
  'one_time_purchase.created',
  'year_end.started',
  'year_end.ready_for_review',
  'year_end.completed',
  'bank_connection.created',
  'bank_transaction.imported',
  'bank_transaction.auto_booked',
  'bank_transaction.needs_review',
  'supplier_invoice.matched',
  'bankgiro_application.submitted',
  'bankgiro_application.approved',
  'bankgiro_application.rejected',
  'payment_provider.activated'
);

insert into public.webhook_events (code, category, description, status) values
  ('invoice.created', 'invoicing', 'Kundfaktura skapad', 'active'),
  ('invoice.sent', 'invoicing', 'Kundfaktura skickad', 'active'),
  ('invoice.paid', 'invoicing', 'Kundfaktura betald', 'active'),
  ('credit_note.created', 'invoicing', 'Kreditfaktura skapad', 'active'),
  ('customer.created', 'invoicing', 'Kund skapad', 'active'),
  ('supplier.created', 'suppliers', 'Leverantör skapad', 'active'),
  ('supplier_invoice.registered', 'suppliers', 'Leverantörsfaktura registrerad', 'active'),
  ('supplier_invoice.approved', 'suppliers', 'Leverantörsfaktura attesterad', 'active'),
  ('supplier_invoice.paid', 'suppliers', 'Leverantörsfaktura betald', 'active'),
  ('supplier_invoice.credited', 'suppliers', 'Leverantörsfaktura krediterad', 'active'),
  ('supplier_invoice.uncredited', 'suppliers', 'Kreditering ångrad', 'active'),
  ('transaction.categorized', 'bank', 'Banktransaktion kategoriserad/bokförd', 'active'),
  ('transaction.reconciled', 'bank', 'Banktransaktion avstämd mot verifikation', 'active'),
  ('transaction.synced', 'bank', 'Banktransaktioner synkade (batch)', 'active'),
  ('bank_connection.expired', 'bank', 'PSD2-samtycke har löpt ut', 'active'),
  ('bank_sync.completed', 'bank', 'Banksynk slutförd', 'active'),
  ('bank_sync.failed', 'bank', 'Banksynk misslyckades', 'active'),
  ('journal_entry.committed', 'bookkeeping', 'Verifikation bokförd', 'active'),
  ('journal_entry.reversed', 'bookkeeping', 'Verifikation vänd (storno)', 'active'),
  ('journal_entry.corrected', 'bookkeeping', 'Verifikation rättad', 'active'),
  ('period.locked', 'bookkeeping', 'Period låst', 'active'),
  ('period.unlocked', 'bookkeeping', 'Period upplåst', 'active'),
  ('period.year_closed', 'bookkeeping', 'Räkenskapsår stängt', 'active'),
  ('salary_run.created', 'payroll', 'Lönekörning skapad', 'active'),
  ('salary_run.approved', 'payroll', 'Lönekörning godkänd', 'active'),
  ('salary_run.booked', 'payroll', 'Lönekörning bokförd', 'active'),
  ('agi.generated', 'payroll', 'AGI-fil genererad', 'active'),
  ('document.uploaded', 'documents', 'Dokument uppladdat', 'active'),
  ('document.extracted', 'documents', 'Dokument AI-tolkat (fält extraherade)', 'active'),
  ('vat_report.generated', 'tax', 'Momsdeklaration beräknad/validerad', 'active'),
  ('tax_submission.waiting_for_signature', 'tax', 'Deklaration väntar på signering hos Skatteverket', 'active'),
  ('tax_submission.submitted', 'tax', 'Deklaration inlämnad (signerad)', 'active'),
  ('tax_submission.failed', 'tax', 'Deklaration avvisad/fel', 'active'),
  ('operation.completed', 'operations', 'Långkörande operation slutförd', 'active'),
  ('operation.failed', 'operations', 'Långkörande operation misslyckades', 'active'),
  ('peppol_invoice.sent', 'peppol', 'E-faktura skickad via Peppol', 'active'),
  ('peppol_invoice.received', 'peppol', 'E-faktura mottagen via Peppol', 'active'),
  ('invoice_financing.offer_created', 'financing', 'Finansieringserbjudande skapat', 'active'),
  ('invoice_financing.paid_out', 'financing', 'Fakturafinansiering utbetald', 'active'),
  ('company.activated', 'company', 'Företag aktiverat (planerad)', 'planned'),
  ('agency.created', 'agency', 'Byrå skapad (planerad)', 'planned'),
  ('agency.client_added', 'agency', 'Byråklient tillagd (planerad)', 'planned'),
  ('subscription.started', 'billing', 'Prenumeration startad (planerad)', 'planned'),
  ('subscription.changed', 'billing', 'Prenumeration ändrad (planerad)', 'planned'),
  ('one_time_purchase.created', 'billing', 'Engångsköp skapat (planerad)', 'planned'),
  ('year_end.started', 'year_end', 'Bokslut startat (planerad)', 'planned'),
  ('year_end.ready_for_review', 'year_end', 'Bokslut klart för granskning (planerad)', 'planned'),
  ('year_end.completed', 'year_end', 'Bokslut slutfört (planerad)', 'planned'),
  ('bank_connection.created', 'bank', 'Bankkoppling skapad (planerad)', 'planned'),
  ('bank_transaction.imported', 'bank', 'Banktransaktion importerad — använd transaction.synced (planerad per-rad)', 'planned'),
  ('bank_transaction.auto_booked', 'bank', 'Banktransaktion autobokförd — använd transaction.categorized (planerad per-rad)', 'planned'),
  ('bank_transaction.needs_review', 'bank', 'Banktransaktion kräver granskning (planerad)', 'planned'),
  ('supplier_invoice.matched', 'suppliers', 'Leverantörsfaktura matchad mot betalning (planerad)', 'planned'),
  ('bankgiro_application.submitted', 'bankgiro', 'Bankgiro-ansökan inskickad (planerad)', 'planned'),
  ('bankgiro_application.approved', 'bankgiro', 'Bankgiro-ansökan godkänd (planerad)', 'planned'),
  ('bankgiro_application.rejected', 'bankgiro', 'Bankgiro-ansökan avslagen (planerad)', 'planned'),
  ('payment_provider.activated', 'payments', 'Betalleverantör aktiverad (planerad)', 'planned')
on conflict (code) do update set
  category = excluded.category,
  description = excluded.description,
  status = excluded.status,
  updated_at = now();

notify pgrst, 'reload schema';
