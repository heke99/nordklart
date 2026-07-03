-- Batch 9 — invoice financing / factoring.
--
-- A customer can offer a SENT customer invoice for financing (sale or
-- borrowing against the receivable) through a financing provider. The
-- provider layer is abstracted; a deterministic sandbox provider ships so
-- the full flow (eligibility → consent → application → offer → accept →
-- payout → settlement) is testable end to end. Production providers plug in
-- behind the same interface and REQUIRE an external agreement.
--
-- Consents: BankID consents for financing REUSE signed_consents from
-- 20260710120000 (consent_type='invoice_financing', context.application_id)
-- — one consent store, one immutability model, one revocation flow. The
-- application row carries consent_id for the direct FK.
--
-- Accounting (see lib/invoice-financing/accounting.ts):
--   non-recourse (sale):  Dr 1930 payout + Dr 6064 fee / Cr 1510 full amount
--   recourse (belåning):  Dr 1512 / Cr 1510 reclass, then
--                         Dr 1930 + Dr 6064 / Cr 2330 factoringkredit
--   VAT-neutral: the financing fee is a financial service (undantagen).

-- ── 1. Providers (global registry) ──────────────────────────────────────────

create table if not exists public.invoice_financing_providers (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  kind text not null default 'external' check (kind in ('sandbox', 'external')),
  status text not null default 'inactive' check (status in ('active', 'inactive', 'requires_agreement')),
  recourse_default boolean not null default false,
  min_amount numeric(14, 2) not null default 1000,
  max_amount numeric(14, 2) null,
  fee_percent_default numeric(5, 2) not null default 3,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.invoice_financing_providers enable row level security;

drop policy if exists invoice_financing_providers_select on public.invoice_financing_providers;
create policy invoice_financing_providers_select on public.invoice_financing_providers
  for select using (auth.uid() is not null);
-- Writes: service role / platform admin migrations only.

insert into public.invoice_financing_providers (slug, name, kind, status, recourse_default, min_amount, fee_percent_default)
values ('sandbox', 'Sandbox Finans (testläge)', 'sandbox', 'active', false, 1000, 3)
on conflict (slug) do nothing;

-- ── 2. Applications ──────────────────────────────────────────────────────────

create table if not exists public.invoice_financing_applications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  provider_slug text not null references public.invoice_financing_providers(slug),

  status text not null default 'submitted' check (status in (
    'submitted', 'needs_more_info', 'offer_created', 'accepted',
    'rejected', 'paid_out', 'settled', 'recourse', 'cancelled'
  )),
  recourse boolean not null default false,
  requested_amount numeric(14, 2) not null check (requested_amount > 0),
  currency text not null default 'SEK',

  -- BankID consent (signed_consents row, consent_type='invoice_financing').
  consent_id uuid null references public.signed_consents(id) on delete set null,

  provider_reference text null,
  error_message text null,
  metadata jsonb not null default '{}'::jsonb,

  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_invoice_financing_applications_company
  on public.invoice_financing_applications (company_id, created_at desc);
create index if not exists idx_invoice_financing_applications_invoice
  on public.invoice_financing_applications (invoice_id);
-- One live application per invoice (terminal states excluded).
create unique index if not exists uq_invoice_financing_active_per_invoice
  on public.invoice_financing_applications (invoice_id)
  where status not in ('rejected', 'cancelled', 'settled');

alter table public.invoice_financing_applications enable row level security;

drop policy if exists invoice_financing_applications_select on public.invoice_financing_applications;
create policy invoice_financing_applications_select on public.invoice_financing_applications
  for select using (
    public.user_can_access_company_v2(company_id) or public.is_platform_admin()
  );

drop policy if exists invoice_financing_applications_insert on public.invoice_financing_applications;
create policy invoice_financing_applications_insert on public.invoice_financing_applications
  for insert with check (public.user_can_access_company_v2(company_id));

drop policy if exists invoice_financing_applications_update on public.invoice_financing_applications;
create policy invoice_financing_applications_update on public.invoice_financing_applications
  for update using (public.user_can_access_company_v2(company_id));

-- ── 3. Offers ────────────────────────────────────────────────────────────────

create table if not exists public.invoice_financing_offers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  application_id uuid not null references public.invoice_financing_applications(id) on delete cascade,

  offered_amount numeric(14, 2) not null,
  fee_percent numeric(5, 2) not null,
  fee_amount numeric(14, 2) not null,
  payout_amount numeric(14, 2) not null,
  recourse boolean not null default false,
  valid_until timestamptz null,

  status text not null default 'open' check (status in ('open', 'accepted', 'declined', 'expired')),
  provider_reference text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_invoice_financing_offers_application
  on public.invoice_financing_offers (application_id);
create index if not exists idx_invoice_financing_offers_company
  on public.invoice_financing_offers (company_id, created_at desc);

alter table public.invoice_financing_offers enable row level security;

drop policy if exists invoice_financing_offers_select on public.invoice_financing_offers;
create policy invoice_financing_offers_select on public.invoice_financing_offers
  for select using (
    public.user_can_access_company_v2(company_id) or public.is_platform_admin()
  );

drop policy if exists invoice_financing_offers_insert on public.invoice_financing_offers;
create policy invoice_financing_offers_insert on public.invoice_financing_offers
  for insert with check (public.user_can_access_company_v2(company_id));

drop policy if exists invoice_financing_offers_update on public.invoice_financing_offers;
create policy invoice_financing_offers_update on public.invoice_financing_offers
  for update using (public.user_can_access_company_v2(company_id));

-- ── 4. Events (append-only audit per application) ───────────────────────────

create table if not exists public.invoice_financing_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  application_id uuid not null references public.invoice_financing_applications(id) on delete cascade,
  event_type text not null,
  status_from text null,
  status_to text null,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_invoice_financing_events_application
  on public.invoice_financing_events (application_id, created_at);

alter table public.invoice_financing_events enable row level security;

drop policy if exists invoice_financing_events_select on public.invoice_financing_events;
create policy invoice_financing_events_select on public.invoice_financing_events
  for select using (
    public.user_can_access_company_v2(company_id) or public.is_platform_admin()
  );

drop policy if exists invoice_financing_events_insert on public.invoice_financing_events;
create policy invoice_financing_events_insert on public.invoice_financing_events
  for insert with check (public.user_can_access_company_v2(company_id));

-- Append-only: block UPDATE (audit trail). DELETE stays allowed only via
-- the application cascade (company/application removal), never row-wise
-- through the API (no delete policy is granted).
drop trigger if exists invoice_financing_events_no_update on public.invoice_financing_events;
create trigger invoice_financing_events_no_update
  before update on public.invoice_financing_events
  for each row execute function public.audit_log_immutable();

-- ── 5. Settlements ───────────────────────────────────────────────────────────

create table if not exists public.invoice_financing_settlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  application_id uuid not null references public.invoice_financing_applications(id) on delete cascade,

  payout_amount numeric(14, 2) not null,
  fee_amount numeric(14, 2) not null,
  recourse boolean not null default false,

  -- The verifikation that booked the payout (1930/6064 vs 1510 or 2330).
  journal_entry_id uuid null references public.journal_entries(id) on delete set null,
  -- The bank transaction the payout was matched against (when ingested).
  transaction_id uuid null references public.transactions(id) on delete set null,

  settled_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_invoice_financing_settlements_company
  on public.invoice_financing_settlements (company_id, settled_at desc);
create index if not exists idx_invoice_financing_settlements_application
  on public.invoice_financing_settlements (application_id);

alter table public.invoice_financing_settlements enable row level security;

drop policy if exists invoice_financing_settlements_select on public.invoice_financing_settlements;
create policy invoice_financing_settlements_select on public.invoice_financing_settlements
  for select using (
    public.user_can_access_company_v2(company_id) or public.is_platform_admin()
  );

drop policy if exists invoice_financing_settlements_insert on public.invoice_financing_settlements;
create policy invoice_financing_settlements_insert on public.invoice_financing_settlements
  for insert with check (public.user_can_access_company_v2(company_id));

NOTIFY pgrst, 'reload schema';
