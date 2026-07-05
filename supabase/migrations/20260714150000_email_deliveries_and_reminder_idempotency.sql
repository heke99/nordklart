-- Outbound email audit + reminder send idempotency.
--
-- 1. email_deliveries: central audit record for every outbound product
--    email (Resend). Written by the email service wrapper with the service
--    role; company owners/admins and platform roles can read their rows.
--    A partial unique index on dedupe_key gives event-replay idempotency:
--    the sender claims a pending row first — a second sender with the same
--    dedupe key hits the unique index and skips the duplicate send.
--    Failed rows leave the index predicate so retries can claim again.
--
-- 2. invoice_reminders: the processor previously inserted the reminder row
--    BEFORE sending with no unique constraint — concurrent cron runs could
--    double-send, and a failed send permanently consumed the level (the
--    row existed, so the level was never retried). Adds send_status +
--    UNIQUE(invoice_id, reminder_level); the processor now claims the row
--    (pending), sends, and marks sent/failed — failed levels are retried
--    on the next run by re-claiming the failed row.
--
-- pg-test: covered-by tests/pg/email-deliveries-reminders.pg.test.ts

-- ── 1. email_deliveries ──────────────────────────────────────────────────────

create table if not exists public.email_deliveries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete set null,
  template_key text,
  recipient text not null,
  subject text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped_duplicate')),
  provider_message_id text,
  error text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.email_deliveries enable row level security;

-- Reads: platform roles (ops) and members of the owning company.
-- Writes: service role only — no INSERT/UPDATE/DELETE policies for
-- authenticated. The email service wrapper always writes with the service
-- client so RLS never blocks the audit trail.
drop policy if exists email_deliveries_select on public.email_deliveries;
create policy email_deliveries_select on public.email_deliveries
  for select using (
    public.is_platform_admin()
    or (company_id is not null and public.user_can_access_company_v2(company_id))
  );

create unique index if not exists idx_email_deliveries_dedupe_claim
  on public.email_deliveries (dedupe_key)
  where dedupe_key is not null and status in ('pending', 'sent');

create index if not exists idx_email_deliveries_company
  on public.email_deliveries (company_id, created_at desc);

create index if not exists idx_email_deliveries_failed
  on public.email_deliveries (created_at desc)
  where status = 'failed';

drop trigger if exists email_deliveries_updated_at on public.email_deliveries;
create trigger email_deliveries_updated_at
  before update on public.email_deliveries
  for each row execute function public.update_updated_at_column();

-- ── 2. invoice_reminders idempotency ─────────────────────────────────────────

alter table public.invoice_reminders
  add column if not exists send_status text not null default 'pending'
    check (send_status in ('pending', 'sent', 'failed', 'duplicate'));

-- Historical rows were only created on the send path — treat them as sent.
update public.invoice_reminders set send_status = 'sent' where send_status = 'pending';

-- Historical double-sends (the exact bug this migration fixes) would break
-- the unique index below. Keep the earliest row per (invoice, level) as the
-- canonical 'sent' record and mark later ones 'duplicate' (audit preserved).
update public.invoice_reminders ir
set send_status = 'duplicate'
where ir.send_status = 'sent'
  and exists (
    select 1 from public.invoice_reminders earlier
    where earlier.invoice_id = ir.invoice_id
      and earlier.reminder_level = ir.reminder_level
      and earlier.send_status = 'sent'
      and (earlier.created_at < ir.created_at
        or (earlier.created_at = ir.created_at and earlier.id < ir.id))
  );

-- One live reminder row per (invoice, level). Concurrency-safe claim: the
-- second inserter hits the unique index; retry-after-failure re-claims the
-- failed row via a compare-and-swap update instead of inserting a duplicate.
create unique index if not exists idx_invoice_reminders_invoice_level
  on public.invoice_reminders (invoice_id, reminder_level)
  where send_status in ('pending', 'sent');

notify pgrst, 'reload schema';
