-- Batch 8 — Peppol / e-invoicing foundation.
--
-- 1. customers.peppol_id — the buyer's Peppol participant identifier
--    (elektronisk adress), e.g. '0007:5566778899' (0007 = SE organisations-
--    nummer scheme) or '0088:GLN'. Validated in the app layer.
--
-- 2. e_invoice_deliveries — one row per outbound/inbound e-invoice with the
--    full delivery lifecycle. The UBL XML is stored verbatim: for outbound
--    it is räkenskapsinformation (the invoice actually issued); for inbound
--    it is the received underlag (BFL 7 kap retention).

alter table public.customers
  add column if not exists peppol_id text null;

comment on column public.customers.peppol_id is
  'Peppol participant identifier (elektronisk adress), e.g. 0007:5566778899. NULL = customer does not receive e-invoices.';

create table if not exists public.e_invoice_deliveries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid null references public.invoices(id) on delete set null,

  direction text not null check (direction in ('outbound', 'inbound')),
  provider text not null default 'sandbox',
  participant_id text null,

  status text not null default 'ready' check (status in (
    'not_configured',      -- no access-point agreement/provider configured
    'ready',               -- validated, ready to send
    'validation_failed',   -- BIS Billing 3 validation failed
    'participant_not_found', -- SMP lookup found no receiving capability
    'sending',             -- handed to the access point
    'sent',                -- accepted by the access point
    'delivered',           -- delivered to the receiver's access point
    'rejected',            -- rejected (by AP or receiver)
    'received',            -- inbound: received, awaiting processing
    'booked',              -- inbound: registered as supplier invoice
    'archived'
  )),

  -- The UBL 2.1 / BIS Billing 3 document, verbatim.
  ubl_xml text null,
  validation_errors jsonb not null default '[]'::jsonb,
  provider_reference text null,
  error_message text null,
  metadata jsonb not null default '{}'::jsonb,

  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_e_invoice_deliveries_company
  on public.e_invoice_deliveries (company_id, created_at desc);
create index if not exists idx_e_invoice_deliveries_invoice
  on public.e_invoice_deliveries (invoice_id)
  where invoice_id is not null;

alter table public.e_invoice_deliveries enable row level security;

drop policy if exists e_invoice_deliveries_select on public.e_invoice_deliveries;
create policy e_invoice_deliveries_select on public.e_invoice_deliveries
  for select using (
    public.user_can_access_company_v2(company_id) or public.is_platform_admin()
  );

drop policy if exists e_invoice_deliveries_insert on public.e_invoice_deliveries;
create policy e_invoice_deliveries_insert on public.e_invoice_deliveries
  for insert with check (
    public.user_can_access_company_v2(company_id)
  );

drop policy if exists e_invoice_deliveries_update on public.e_invoice_deliveries;
create policy e_invoice_deliveries_update on public.e_invoice_deliveries
  for update using (
    public.user_can_access_company_v2(company_id)
  );

comment on table public.e_invoice_deliveries is
  'Peppol e-invoice deliveries (outbound + inbound) with lifecycle status. UBL stored verbatim (BFL 7 kap).';

NOTIFY pgrst, 'reload schema';
