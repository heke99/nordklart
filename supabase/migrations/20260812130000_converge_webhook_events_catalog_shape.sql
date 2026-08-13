-- Converge public.webhook_events to the shape the migration chain defines.
--
-- 20260626120000 creates this catalog with `code` as the primary key and a
-- payload_schema column. In production that table was missing when
-- 20260714160000 ran, and that migration's `create table if not exists` built
-- it from its own fallback definition instead — `id uuid primary key`, no
-- payload_schema, and defaults on category and description. A clean replay
-- never takes that branch, because 20260626120000 has already created the
-- table, so the two databases have disagreed on this table ever since and no
-- later migration reconciles them.
--
-- Deploying 20260714160000 would not fix it: its create-table branch is exactly
-- the shape production already has. The reshape has to be stated, and this is
-- it:
--
--   payload_schema   added — canonical carries it NOT NULL DEFAULT '{}'
--   category         drop default 'general'
--   description      drop default ''
--   id               drop NOT NULL (canonical keeps the column, nullable)
--   primary key      moves from (id) to (code)
--
-- `code` is already NOT NULL and already carries a unique index
-- (webhook_events_code_uidx, which canonical also has alongside the primary
-- key), so promoting it is a metadata change with nothing to validate. The
-- catalog holds 62 rows and no tenant data; two views read it and neither
-- selects id.
--
-- On a database that already matches the chain this migration is a no-op.
--
-- pg-test: covered-by tests/pg/tenant-isolation-matrix.pg.test.ts

BEGIN;

alter table public.webhook_events
  add column if not exists payload_schema jsonb not null default '{}'::jsonb;

alter table public.webhook_events
  alter column category drop default;

alter table public.webhook_events
  alter column description drop default;

-- The key moves before id's NOT NULL is dropped: PostgreSQL refuses to relax a
-- column that is still part of the primary key ("column \"id\" is in a primary
-- key"). A clean replay never notices the ordering, because there the key is
-- already on `code` and both statements are no-ops — which is precisely how an
-- ordering bug survives a local test and only appears against the database that
-- actually drifted.
do $$
begin
  -- Only move the key when it is still on the fallback column.
  if exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'webhook_events'
      and con.conname = 'webhook_events_pkey'
      and pg_get_constraintdef(con.oid) = 'PRIMARY KEY (id)'
  ) then
    alter table public.webhook_events drop constraint webhook_events_pkey;
    alter table public.webhook_events add constraint webhook_events_pkey primary key (code);
  end if;
end
$$;

alter table public.webhook_events
  alter column id drop not null;

COMMIT;

NOTIFY pgrst, 'reload schema';
