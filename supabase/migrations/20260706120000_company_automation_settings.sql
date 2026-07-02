-- ── Company-controlled bank automation ───────────────────────────────────────
--
-- Replaces the NODE_ENV-gated auto-booking in lib/transactions/ingest.ts with
-- per-company automation settings. The decision engine
-- (lib/automation/bank-transaction-automation.ts) reads these settings, writes
-- transaction_match_candidates + automation_decisions rows (schema from
-- 20260625120000), and stages pending_operations for anything uncertain.
--
-- Safe to run once: all DDL is IF NOT EXISTS / idempotent drops+adds.

-- 1. Per-company automation settings ------------------------------------------

create table if not exists public.company_automation_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,

  -- How imported/synced bank transactions are processed.
  --   off       → no automation at all (not even suggestions)
  --   suggest   → build candidates + suggestions, never book
  --   auto_safe → auto-commit only rock-safe matches (see allow_* flags)
  --   auto_full → auto-commit everything above min_auto_confidence
  bank_transaction_mode text not null default 'suggest'
    check (bank_transaction_mode in ('off', 'suggest', 'auto_safe', 'auto_full')),

  invoice_payment_matching_mode text not null default 'auto_safe'
    check (invoice_payment_matching_mode in ('off', 'suggest', 'auto_safe', 'auto_full')),

  supplier_invoice_matching_mode text not null default 'suggest'
    check (supplier_invoice_matching_mode in ('off', 'suggest', 'auto_safe', 'auto_full')),

  -- What happens right after a bank sync / bank-file import.
  --   off             → imported rows are left not_evaluated
  --   suggest_only    → candidates + suggestions only
  --   process_pending → suggestions + pending operations for review
  --   auto_safe       → also auto-commit safe matches per the modes above
  bank_import_after_sync_mode text not null default 'process_pending'
    check (bank_import_after_sync_mode in ('off', 'suggest_only', 'process_pending', 'auto_safe')),

  min_auto_confidence numeric not null default 0.95
    check (min_auto_confidence between 0 and 1),
  min_suggestion_confidence numeric not null default 0.70
    check (min_suggestion_confidence between 0 and 1),
  max_auto_book_amount numeric null
    check (max_auto_book_amount is null or max_auto_book_amount > 0),

  allow_auto_customer_invoice_settlement boolean not null default true,
  allow_auto_supplier_invoice_settlement boolean not null default false,
  allow_auto_bank_fee_booking boolean not null default true,
  allow_auto_category_booking boolean not null default false,
  allow_auto_tax_payment_booking boolean not null default false,
  allow_auto_salary_payment_booking boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.company_automation_settings is
  'Per-company controlled-automation settings for bank transaction processing. Missing row = conservative defaults (suggest mode).';

drop trigger if exists company_automation_settings_updated_at on public.company_automation_settings;
create trigger company_automation_settings_updated_at
  before update on public.company_automation_settings
  for each row execute function public.update_updated_at_column();

alter table public.company_automation_settings enable row level security;

-- Members read; admins/owners write; platform admins manage everything.
drop policy if exists company_automation_settings_select on public.company_automation_settings;
create policy company_automation_settings_select on public.company_automation_settings
  for select using (
    public.user_can_access_company_v2(company_id) or public.is_platform_admin()
  );

drop policy if exists company_automation_settings_insert on public.company_automation_settings;
create policy company_automation_settings_insert on public.company_automation_settings
  for insert with check (
    public.user_is_company_admin(company_id) or public.is_platform_admin()
  );

drop policy if exists company_automation_settings_update on public.company_automation_settings;
create policy company_automation_settings_update on public.company_automation_settings
  for update
  using (public.user_is_company_admin(company_id) or public.is_platform_admin())
  with check (public.user_is_company_admin(company_id) or public.is_platform_admin());

drop policy if exists company_automation_settings_delete on public.company_automation_settings;
create policy company_automation_settings_delete on public.company_automation_settings
  for delete using (
    public.user_is_company_admin(company_id) or public.is_platform_admin()
  );

-- Changing automation posture is a control-relevant event — audit it.
drop trigger if exists company_automation_settings_audit on public.company_automation_settings;
create trigger company_automation_settings_audit
  after insert or update or delete on public.company_automation_settings
  for each row execute function public.write_audit_log();

-- 2. automation_decisions: idempotency + provenance ---------------------------
--
-- The table (20260625120000) predates the runtime engine. Every automated
-- write needs a deterministic idempotency key so a retried cron/import can
-- never double-decide (and thus never double-book).

alter table public.automation_decisions
  add column if not exists idempotency_key text,
  add column if not exists source text not null default 'bank_transaction',
  add column if not exists created_by uuid references auth.users(id) on delete set null;

create unique index if not exists idx_automation_decisions_company_idem
  on public.automation_decisions(company_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.automation_decisions.idempotency_key is
  'Deterministic key (source:transaction_id:evaluation-scope). Unique per company — a retried sync/import replays the stored decision instead of re-deciding.';

-- Member INSERT/UPDATE/DELETE on automation_decisions and
-- transaction_match_candidates are already covered by the company-scoped
-- `<table>_write` FOR ALL policies from 20260625120000.

-- 3. Actor plumbing for automation --------------------------------------------
--
-- The automation engine stages pending_operations (uncertain cases) and — in
-- auto_safe/auto_full mode — commits journal entries. Both paths record WHO
-- acted; 'automation' distinguishes engine writes from human/agent/cron ones.

alter table public.pending_operations
  drop constraint if exists pending_operations_actor_type_check;
alter table public.pending_operations
  add constraint pending_operations_actor_type_check check (actor_type in (
    'user', 'api_key', 'mcp_oauth', 'cron', 'agent_chat', 'automation'
  ));

alter table public.audit_log
  drop constraint if exists audit_log_actor_type_check;
alter table public.audit_log
  add constraint audit_log_actor_type_check check (actor_type in (
    'user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'automation'
  ));

alter table public.journal_entries
  drop constraint if exists journal_entries_committed_actor_type_check;
alter table public.journal_entries
  add constraint journal_entries_committed_actor_type_check
  check (committed_actor_type is null or committed_actor_type in (
    'user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'automation'
  ));

alter table public.journal_entries
  drop constraint if exists journal_entries_commit_method_check;
alter table public.journal_entries
  add constraint journal_entries_commit_method_check
  check (commit_method is null or commit_method in (
    'user_accept', 'bulk_accept', 'timing_ceiling', 'migration', 'legacy', 'agent', 'api_key', 'automation'
  ));

-- payment_match_log.action: add 'auto_matched' (engine-committed matches) and
-- 'linked_to_existing_voucher' (already in the TS union — its inserts were
-- silently rejected by the old CHECK because logMatchEvent is fire-and-forget).
alter table public.payment_match_log
  drop constraint if exists payment_match_log_action_check;
alter table public.payment_match_log
  add constraint payment_match_log_action_check check (action in (
    'matched',
    'unmatched',
    'auto_suggested',
    'auto_matched',
    'evaluated',
    'suggestion_cleared',
    'storno_conflict_resolved',
    'linked_to_existing_voucher'
  ));

-- Session-client inserts of automation-staged operations (mirrors the
-- agent_chat insert policy from 20260523121000).
drop policy if exists pending_operations_automation_insert on public.pending_operations;
create policy pending_operations_automation_insert on public.pending_operations
  for insert with check (
    actor_type = 'automation'
    and auth.uid() = user_id
    and company_id in (select public.user_company_ids())
  );

notify pgrst, 'reload schema';
