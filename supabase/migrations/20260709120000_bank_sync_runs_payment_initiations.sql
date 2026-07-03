-- Batch 3 — bank automation completion
--
-- 1. bank_sync_runs: audit trail for every PSD2/bank-file sync attempt.
--    Powers the sync-status UI (last successful sync, last error, partial
--    syncs) and the platform integration health view. Written by the
--    Enable Banking extension sync + cron and by bank-file imports.
--
-- 2. payment_initiations: outbound payment files (pain.001 / Bankgirot LB)
--    generated for supplier payments, salary and tax. The pain.002 status
--    report updates `status` via original message id. The generated file is
--    räkenskapsinformation (BFL 7 kap — 7-year retention) so file content is
--    stored inline and rows must never be hard-deleted once exported.
--
-- Both tables are multi-tenant: company_id NOT NULL + RLS via
-- user_can_access_company_v2, indexes on company_id.

-- ── 0. bank_connections.consent_status: allow 'consent_required' ────────────
-- The PSD2 consent can require re-authorisation before it has formally
-- expired (SCA renewal). Distinct from 'expired' so the UI can nudge with
-- "förnya samtycket" instead of "anslut igen".

alter table public.bank_connections
  drop constraint if exists bank_connections_consent_status_check;
alter table public.bank_connections
  add constraint bank_connections_consent_status_check
  check (consent_status in ('unknown', 'pending', 'active', 'expired', 'revoked', 'error', 'consent_required'));

-- ── 1. bank_sync_runs ────────────────────────────────────────────────────────

create table if not exists public.bank_sync_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_connection_id uuid null references public.bank_connections(id) on delete set null,

  provider text not null default 'enable_banking',
  trigger_source text not null default 'manual'
    check (trigger_source in ('manual', 'cron', 'initial_backfill', 'file_import')),

  status text not null default 'running'
    check (status in ('running', 'success', 'partial', 'failed')),

  started_at timestamptz not null default now(),
  finished_at timestamptz null,

  accounts_synced int not null default 0,
  transactions_imported int not null default 0,
  transactions_deduplicated int not null default 0,

  error_message text null,
  -- Per-account errors / diagnostics for partial syncs.
  details jsonb not null default '{}'::jsonb,

  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_bank_sync_runs_company
  on public.bank_sync_runs (company_id, started_at desc);
create index if not exists idx_bank_sync_runs_connection
  on public.bank_sync_runs (bank_connection_id, started_at desc)
  where bank_connection_id is not null;

alter table public.bank_sync_runs enable row level security;

drop policy if exists bank_sync_runs_select on public.bank_sync_runs;
create policy bank_sync_runs_select on public.bank_sync_runs
  for select using (
    public.user_can_access_company_v2(company_id) or public.is_platform_admin()
  );

drop policy if exists bank_sync_runs_insert on public.bank_sync_runs;
create policy bank_sync_runs_insert on public.bank_sync_runs
  for insert with check (
    public.user_can_access_company_v2(company_id)
  );

drop policy if exists bank_sync_runs_update on public.bank_sync_runs;
create policy bank_sync_runs_update on public.bank_sync_runs
  for update using (
    public.user_can_access_company_v2(company_id)
  );

comment on table public.bank_sync_runs is
  'Audit trail per bank sync attempt (PSD2 or file import): status, counts, errors. Read by sync-status UI and platform integration health.';

-- ── 2. payment_initiations ───────────────────────────────────────────────────

create table if not exists public.payment_initiations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid null references auth.users(id) on delete set null,

  kind text not null
    check (kind in ('supplier_payment', 'salary', 'tax')),
  method text not null
    check (method in ('pain001', 'bg_lb')),

  -- pain.001 <MsgId> / LB batch reference. Unique per company so a pain.002
  -- (OrgnlMsgId) resolves to exactly one initiation.
  message_id text not null,

  status text not null default 'created'
    check (status in (
      'created', 'exported', 'uploaded', 'pending',
      'accepted', 'partially_accepted', 'rejected', 'settled', 'cancelled'
    )),

  payment_date date not null,
  currency text not null default 'SEK',
  total_amount numeric(15, 2) not null check (total_amount >= 0),
  payment_count int not null default 0,

  file_name text not null,
  -- Räkenskapsinformation: the exact file content handed to the bank.
  file_content text not null,

  -- End-to-end ids and per-payment metadata:
  --   [{ end_to_end_id, supplier_invoice_id?, amount, creditor_name, status?, reason_code? }]
  payments jsonb not null default '[]'::jsonb,

  -- AP linkage for supplier payments (query convenience; the authoritative
  -- per-payment mapping lives in `payments`).
  supplier_invoice_ids uuid[] not null default '{}'::uuid[],

  status_updated_at timestamptz null,
  error_message text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_payment_initiations_message
  on public.payment_initiations (company_id, message_id);
create index if not exists idx_payment_initiations_company
  on public.payment_initiations (company_id, created_at desc);

alter table public.payment_initiations enable row level security;

drop policy if exists payment_initiations_select on public.payment_initiations;
create policy payment_initiations_select on public.payment_initiations
  for select using (
    public.user_can_access_company_v2(company_id) or public.is_platform_admin()
  );

drop policy if exists payment_initiations_insert on public.payment_initiations;
create policy payment_initiations_insert on public.payment_initiations
  for insert with check (
    public.user_can_access_company_v2(company_id)
  );

drop policy if exists payment_initiations_update on public.payment_initiations;
create policy payment_initiations_update on public.payment_initiations
  for update using (
    public.user_can_access_company_v2(company_id)
  );

-- BFL 7 kap: once a payment file has been exported it is
-- räkenskapsinformation — block hard deletes entirely (cancelling is a
-- status transition, not a delete).
create or replace function public.prevent_payment_initiation_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status <> 'created' then
    raise exception 'Betalfiler är räkenskapsinformation (BFL 7 kap) och får inte raderas efter export. Avbryt betalningen i stället (status=cancelled).';
  end if;
  return old;
end;
$$;

drop trigger if exists payment_initiations_no_delete on public.payment_initiations;
create trigger payment_initiations_no_delete
  before delete on public.payment_initiations
  for each row execute function public.prevent_payment_initiation_delete();

comment on table public.payment_initiations is
  'Outbound payment files (pain.001 / Bankgirot LB) for supplier/salary/tax payments. Status updated from pain.002 reports. File content retained 7 years per BFL.';

NOTIFY pgrst, 'reload schema';
