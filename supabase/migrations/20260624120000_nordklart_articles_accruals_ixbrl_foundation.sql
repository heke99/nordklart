-- Nordklart: artikelregister, periodiseringar och digital årsredovisning foundation.
-- Safe/idempotent migration. No XLSX/Excel dependency is introduced here.
-- Accounting guardrails preserved: VAT is not deferred; periodisering creates
-- ordinary balanced journal entries via source_type='accrual'.

-- -----------------------------------------------------------------------------
-- Artikelregister (non-inventory invoice line presets)
-- -----------------------------------------------------------------------------
create table if not exists public.articles (
  id uuid default gen_random_uuid() primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  article_number text,
  name text not null,
  name_en text,
  type text not null default 'tjanst' check (type in ('vara', 'tjanst')),
  unit text not null default 'st',
  price_excl_vat numeric not null default 0,
  vat_rate integer not null default 25 check (vat_rate in (0, 6, 12, 25)),
  revenue_account text,
  cost_price numeric,
  ean text,
  housework_type text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.articles enable row level security;

create index if not exists idx_articles_company_id on public.articles(company_id);
create index if not exists idx_articles_company_active on public.articles(company_id, name) where active;
create unique index if not exists uq_articles_company_number on public.articles(company_id, article_number) where article_number is not null;

drop policy if exists articles_select on public.articles;
create policy articles_select on public.articles for select
  using (public.user_can_access_company_v2(company_id));

drop policy if exists articles_insert on public.articles;
create policy articles_insert on public.articles for insert
  with check (public.user_can_access_company_v2(company_id));

drop policy if exists articles_update on public.articles;
create policy articles_update on public.articles for update
  using (public.user_can_access_company_v2(company_id))
  with check (public.user_can_access_company_v2(company_id));

drop policy if exists articles_delete on public.articles;
create policy articles_delete on public.articles for delete
  using (public.user_can_access_company_v2(company_id));

drop trigger if exists set_updated_at_articles on public.articles;
create trigger set_updated_at_articles
  before update on public.articles
  for each row execute function public.update_updated_at_column();

drop trigger if exists audit_articles on public.articles;
create trigger audit_articles
  after insert or update or delete on public.articles
  for each row execute function public.write_audit_log();

alter table public.company_settings
  add column if not exists next_article_number integer not null default 1;

create or replace function public.generate_article_number(p_company_id uuid, p_article_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existing text;
  v_number integer;
  v_final text;
begin
  if not public.user_can_access_company_v2(p_company_id) then
    raise exception 'Not authorized for company %', p_company_id using errcode = '42501';
  end if;

  select article_number into v_existing
  from public.articles
  where id = p_article_id and company_id = p_company_id
  for update;

  if not found then
    raise exception 'Article % not found in company %', p_article_id, p_company_id;
  end if;

  if v_existing is not null then
    return v_existing;
  end if;

  update public.company_settings
  set next_article_number = next_article_number + 1,
      updated_at = now()
  where company_id = p_company_id
  returning next_article_number - 1 into v_number;

  if v_number is null then
    raise exception 'Company settings not found for company %', p_company_id;
  end if;

  v_final := v_number::text;

  update public.articles
  set article_number = v_final
  where id = p_article_id and company_id = p_company_id;

  return v_final;
end;
$$;

alter table public.invoice_items
  add column if not exists revenue_account text,
  add column if not exists article_id uuid references public.articles(id) on delete set null,
  add column if not exists line_type text not null default 'product' check (line_type in ('product', 'text'));

create index if not exists idx_invoice_items_article_id on public.invoice_items(article_id);

-- -----------------------------------------------------------------------------
-- Periodiseringar (accrual schedules)
-- -----------------------------------------------------------------------------
create table if not exists public.accrual_schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  direction text not null check (direction in ('expense', 'revenue')),
  supplier_invoice_id uuid references public.supplier_invoices(id) on delete restrict,
  supplier_invoice_item_id uuid references public.supplier_invoice_items(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete restrict,
  invoice_item_id uuid references public.invoice_items(id) on delete set null,
  balance_account text not null,
  target_account text not null,
  total_amount numeric(15, 2) not null check (total_amount > 0),
  period_start date not null,
  period_end date not null,
  months integer not null check (months >= 1),
  origin_journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  posting_floor_date date not null default current_date,
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accrual_schedules_period_valid check (period_end >= period_start),
  constraint accrual_schedules_one_source check ((supplier_invoice_id is not null)::int + (invoice_id is not null)::int = 1),
  constraint accrual_schedules_direction_matches_source check ((direction = 'expense' and supplier_invoice_id is not null) or (direction = 'revenue' and invoice_id is not null)),
  constraint accrual_schedules_balance_account_range check ((direction = 'expense' and balance_account ~ '^17[0-9]{2}$') or (direction = 'revenue' and balance_account ~ '^29[0-9]{2}$')),
  constraint accrual_schedules_target_account_range check (target_account ~ '^[1-8][0-9]{3}$')
);

create index if not exists idx_accrual_schedules_company on public.accrual_schedules(company_id);
create index if not exists idx_accrual_schedules_company_status on public.accrual_schedules(company_id, status);
create index if not exists idx_accrual_schedules_supplier_invoice on public.accrual_schedules(supplier_invoice_id) where supplier_invoice_id is not null;
create index if not exists idx_accrual_schedules_invoice on public.accrual_schedules(invoice_id) where invoice_id is not null;

alter table public.accrual_schedules enable row level security;

drop policy if exists accrual_schedules_select on public.accrual_schedules;
create policy accrual_schedules_select on public.accrual_schedules for select using (public.user_can_access_company_v2(company_id));
drop policy if exists accrual_schedules_insert on public.accrual_schedules;
create policy accrual_schedules_insert on public.accrual_schedules for insert with check (public.user_can_access_company_v2(company_id));
drop policy if exists accrual_schedules_update on public.accrual_schedules;
create policy accrual_schedules_update on public.accrual_schedules for update using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id));

drop trigger if exists set_updated_at_accrual_schedules on public.accrual_schedules;
create trigger set_updated_at_accrual_schedules before update on public.accrual_schedules for each row execute function public.update_updated_at_column();
drop trigger if exists audit_accrual_schedules on public.accrual_schedules;
create trigger audit_accrual_schedules after insert or update or delete on public.accrual_schedules for each row execute function public.write_audit_log();

create table if not exists public.accrual_schedule_installments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  schedule_id uuid not null references public.accrual_schedules(id) on delete cascade,
  period_month date not null,
  amount numeric(15, 2) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'posted', 'cancelled')),
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  posted_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accrual_installments_unique unique (schedule_id, period_month),
  constraint accrual_installments_month_normalized check (period_month = date_trunc('month', period_month)::date),
  constraint accrual_installments_posted_consistent check (status <> 'posted' or journal_entry_id is not null)
);

create index if not exists idx_accrual_installments_company on public.accrual_schedule_installments(company_id);
create index if not exists idx_accrual_installments_schedule on public.accrual_schedule_installments(schedule_id);
create index if not exists idx_accrual_installments_due on public.accrual_schedule_installments(period_month) where status = 'pending';

alter table public.accrual_schedule_installments enable row level security;

drop policy if exists accrual_installments_select on public.accrual_schedule_installments;
create policy accrual_installments_select on public.accrual_schedule_installments for select using (public.user_can_access_company_v2(company_id));
drop policy if exists accrual_installments_insert on public.accrual_schedule_installments;
create policy accrual_installments_insert on public.accrual_schedule_installments for insert with check (public.user_can_access_company_v2(company_id));
drop policy if exists accrual_installments_update on public.accrual_schedule_installments;
create policy accrual_installments_update on public.accrual_schedule_installments for update using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id));
drop policy if exists accrual_installments_delete on public.accrual_schedule_installments;
create policy accrual_installments_delete on public.accrual_schedule_installments for delete using (public.user_can_access_company_v2(company_id) and journal_entry_id is null);

drop policy if exists accrual_schedules_delete on public.accrual_schedules;
create policy accrual_schedules_delete on public.accrual_schedules for delete using (
  public.user_can_access_company_v2(company_id)
  and not exists (select 1 from public.accrual_schedule_installments i where i.schedule_id = accrual_schedules.id and i.journal_entry_id is not null)
);

drop trigger if exists set_updated_at_accrual_installments on public.accrual_schedule_installments;
create trigger set_updated_at_accrual_installments before update on public.accrual_schedule_installments for each row execute function public.update_updated_at_column();
drop trigger if exists audit_accrual_installments on public.accrual_schedule_installments;
create trigger audit_accrual_installments after insert or update or delete on public.accrual_schedule_installments for each row execute function public.write_audit_log();

create or replace function public.enforce_accrual_installment_immutability()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if old.journal_entry_id is not null then
    if new.amount is distinct from old.amount
       or new.period_month is distinct from old.period_month
       or new.schedule_id is distinct from old.schedule_id
       or new.journal_entry_id is distinct from old.journal_entry_id then
      raise exception 'Cannot modify a posted accrual installment (id=%)', old.id using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_accrual_installment_immutability on public.accrual_schedule_installments;
create trigger enforce_accrual_installment_immutability before update on public.accrual_schedule_installments for each row execute function public.enforce_accrual_installment_immutability();

alter table public.supplier_invoice_items
  add column if not exists accrual_period_start date,
  add column if not exists accrual_period_end date,
  add column if not exists accrual_balance_account text;

alter table public.supplier_invoice_items drop constraint if exists supplier_invoice_items_accrual_atomic;
alter table public.supplier_invoice_items add constraint supplier_invoice_items_accrual_atomic check (
  (accrual_period_start is null and accrual_period_end is null)
  or (accrual_period_start is not null and accrual_period_end is not null and accrual_period_end >= accrual_period_start)
);
alter table public.supplier_invoice_items drop constraint if exists supplier_invoice_items_accrual_account_range;
alter table public.supplier_invoice_items add constraint supplier_invoice_items_accrual_account_range check (accrual_balance_account is null or accrual_balance_account ~ '^17[0-9]{2}$');

alter table public.invoice_items
  add column if not exists accrual_period_start date,
  add column if not exists accrual_period_end date,
  add column if not exists accrual_balance_account text;

alter table public.invoice_items drop constraint if exists invoice_items_accrual_atomic;
alter table public.invoice_items add constraint invoice_items_accrual_atomic check (
  (accrual_period_start is null and accrual_period_end is null)
  or (accrual_period_start is not null and accrual_period_end is not null and accrual_period_end >= accrual_period_start)
);
alter table public.invoice_items drop constraint if exists invoice_items_accrual_account_range;
alter table public.invoice_items add constraint invoice_items_accrual_account_range check (accrual_balance_account is null or accrual_balance_account ~ '^29[0-9]{2}$');

alter table public.journal_entries drop constraint if exists journal_entries_source_type_check;
alter table public.journal_entries add constraint journal_entries_source_type_check check (source_type in (
  'manual', 'bank_transaction', 'invoice_created', 'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
  'opening_balance', 'year_end', 'storno', 'correction', 'import', 'system', 'inbox_item',
  'supplier_invoice_registered', 'supplier_invoice_paid', 'supplier_invoice_cash_payment', 'supplier_credit_note',
  'currency_revaluation', 'supplier_invoice_privately_paid', 'reminder_fee', 'accrual'
));

update public.company_settings
set default_voucher_series_per_source_type = coalesce(default_voucher_series_per_source_type, '{}'::jsonb) || '{"accrual":"A"}'::jsonb
where not (coalesce(default_voucher_series_per_source_type, '{}'::jsonb) ? 'accrual');

-- -----------------------------------------------------------------------------
-- Digital årsredovisning / Bolagsverket state foundation
-- -----------------------------------------------------------------------------
create table if not exists public.arsredovisning_submissions (
  id uuid default gen_random_uuid() primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  fiscal_period_id uuid not null references public.fiscal_periods(id) on delete cascade,
  handling_typ text not null default 'arsredovisning_komplett' check (handling_typ in ('arsredovisning_komplett', 'arsredovisning', 'revisionsberattelse')),
  taxonomy_version text not null,
  entry_point text not null,
  environment text not null default 'test' check (environment in ('test', 'accept', 'prod')),
  status text not null default 'draft' check (status in ('draft', 'kontrollerad', 'uploaded', 'inkommen', 'forelagd', 'komplettering', 'registrerad', 'avslutad', 'error')),
  undertecknare_namn text,
  undertecknare_epost text,
  undertecknare_pnr_hash text,
  avsandare_pnr_hash text,
  idnummer text,
  sha256_checksumma text,
  kontrollsumma text,
  bolagsverket_url text,
  kontrollera_utfall jsonb,
  dokument_id uuid references public.document_attachments(id),
  error_message text,
  uploaded_at timestamptz,
  registered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.arsredovisning_submissions enable row level security;
drop policy if exists arsredovisning_submissions_select on public.arsredovisning_submissions;
create policy arsredovisning_submissions_select on public.arsredovisning_submissions for select using (public.user_can_access_company_v2(company_id));
drop policy if exists arsredovisning_submissions_insert on public.arsredovisning_submissions;
create policy arsredovisning_submissions_insert on public.arsredovisning_submissions for insert with check (public.user_can_access_company_v2(company_id));
drop policy if exists arsredovisning_submissions_update on public.arsredovisning_submissions;
create policy arsredovisning_submissions_update on public.arsredovisning_submissions for update using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id));

create index if not exists idx_arsred_submissions_company on public.arsredovisning_submissions(company_id, fiscal_period_id);
create index if not exists idx_arsred_submissions_status on public.arsredovisning_submissions(company_id, status);
create index if not exists idx_arsred_submissions_idnummer on public.arsredovisning_submissions(idnummer) where idnummer is not null;

drop trigger if exists set_updated_at_arsred_submissions on public.arsredovisning_submissions;
create trigger set_updated_at_arsred_submissions before update on public.arsredovisning_submissions for each row execute function public.update_updated_at_column();
drop trigger if exists audit_arsred_submissions on public.arsredovisning_submissions;
create trigger audit_arsred_submissions after insert or update or delete on public.arsredovisning_submissions for each row execute function public.write_audit_log();

create table if not exists public.bolagsverket_avtal_acceptances (
  id uuid default gen_random_uuid() primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  avtalstext_andrad text not null,
  accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.bolagsverket_avtal_acceptances enable row level security;
drop policy if exists bolagsverket_avtal_acceptances_select on public.bolagsverket_avtal_acceptances;
create policy bolagsverket_avtal_acceptances_select on public.bolagsverket_avtal_acceptances for select using (public.user_can_access_company_v2(company_id));
drop policy if exists bolagsverket_avtal_acceptances_insert on public.bolagsverket_avtal_acceptances;
create policy bolagsverket_avtal_acceptances_insert on public.bolagsverket_avtal_acceptances for insert with check (public.user_can_access_company_v2(company_id) and user_id = auth.uid());
create unique index if not exists uq_bolagsverket_avtal_acceptance on public.bolagsverket_avtal_acceptances(company_id, user_id, avtalstext_andrad);

create table if not exists public.bolagsverket_subscriptions (
  id uuid default gen_random_uuid() primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  orgnr text not null,
  url text not null,
  auth_secret text not null,
  environment text not null default 'test' check (environment in ('test', 'accept', 'prod')),
  subscribed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bolagsverket_subscriptions enable row level security;
drop policy if exists bolagsverket_subscriptions_select on public.bolagsverket_subscriptions;
create policy bolagsverket_subscriptions_select on public.bolagsverket_subscriptions for select using (public.user_can_access_company_v2(company_id));
drop policy if exists bolagsverket_subscriptions_insert on public.bolagsverket_subscriptions;
create policy bolagsverket_subscriptions_insert on public.bolagsverket_subscriptions for insert with check (public.user_can_access_company_v2(company_id));
drop policy if exists bolagsverket_subscriptions_update on public.bolagsverket_subscriptions;
create policy bolagsverket_subscriptions_update on public.bolagsverket_subscriptions for update using (public.user_can_access_company_v2(company_id)) with check (public.user_can_access_company_v2(company_id));
drop policy if exists bolagsverket_subscriptions_delete on public.bolagsverket_subscriptions;
create policy bolagsverket_subscriptions_delete on public.bolagsverket_subscriptions for delete using (public.user_can_access_company_v2(company_id));
create unique index if not exists uq_bolagsverket_subscription on public.bolagsverket_subscriptions(company_id, orgnr, url, environment);
create index if not exists idx_bolagsverket_subscriptions_orgnr on public.bolagsverket_subscriptions(orgnr);

drop trigger if exists set_updated_at_bolagsverket_subscriptions on public.bolagsverket_subscriptions;
create trigger set_updated_at_bolagsverket_subscriptions before update on public.bolagsverket_subscriptions for each row execute function public.update_updated_at_column();

notify pgrst, 'reload schema';
