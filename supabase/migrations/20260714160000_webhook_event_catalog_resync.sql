-- =====================================================================
-- Webhook events catalog foundation + resync
-- Fixes missing public.webhook_events before catalog sync.
-- =====================================================================

create extension if not exists pgcrypto;

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  category text not null default 'general',
  description text not null default '',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.webhook_events
  add column if not exists id uuid default gen_random_uuid();

alter table public.webhook_events
  add column if not exists code text;

alter table public.webhook_events
  add column if not exists category text default 'general';

alter table public.webhook_events
  add column if not exists description text default '';

alter table public.webhook_events
  add column if not exists status text default 'active';

alter table public.webhook_events
  add column if not exists created_at timestamptz default now();

alter table public.webhook_events
  add column if not exists updated_at timestamptz default now();

update public.webhook_events
set
  category = coalesce(category, 'general'),
  description = coalesce(description, ''),
  status = coalesce(status, 'active'),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, now())
where category is null
   or description is null
   or status is null
   or created_at is null
   or updated_at is null;

delete from public.webhook_events a
using public.webhook_events b
where a.ctid < b.ctid
  and a.code = b.code;

create unique index if not exists webhook_events_code_uidx
  on public.webhook_events (code);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'webhook_events_status_check'
      and conrelid = 'public.webhook_events'::regclass
  ) then
    alter table public.webhook_events
      add constraint webhook_events_status_check
      check (status in ('active', 'planned', 'deprecated'));
  end if;
end $$;

-- Lock direct browser/PostgREST access unless explicit policies already exist.
alter table public.webhook_events enable row level security;

-- =====================================================================
-- Webhook event catalog resync
-- =====================================================================

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
  ('payment_provider.activated', 'payments', 'Betalleverantör aktiverad', 'planned')
on conflict (code) do update set
  category = excluded.category,
  description = excluded.description,
  status = excluded.status,
  updated_at = now();

notify pgrst, 'reload schema';