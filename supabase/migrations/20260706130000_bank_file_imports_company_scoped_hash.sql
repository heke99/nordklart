-- ── Company-scoped bank-file dedup ───────────────────────────────────────────
--
-- bank_file_imports carried a UNIQUE (user_id, file_hash) from the
-- single-tenant era. Multi-tenant consequences:
--   * the same user importing the same file into TWO companies silently
--     overwrote the first company's import row (upsert stole the row), and
--   * two different users importing the same file into ONE company created
--     duplicate import records for the same content.
--
-- The correct dedup scope is the company: one completed import per
-- (company_id, file_hash). Old rows are preserved — colliding older rows get
-- a suffixed hash so history stays intact while the key is freed.
--
-- Safe to run once: guarded drops/creates; the dedup UPDATE only touches rows
-- that actually collide.

-- 1. Free colliding keys: keep the newest row per (company_id, file_hash),
--    suffix the hash on older duplicates. Rows with NULL company_id are left
--    untouched (NULLs never collide in a unique constraint).
with ranked as (
  select
    id,
    row_number() over (
      partition by company_id, file_hash
      order by created_at desc, id desc
    ) as rn
  from public.bank_file_imports
  where company_id is not null
)
update public.bank_file_imports b
set file_hash = b.file_hash || ':superseded:' || b.id
from ranked r
where b.id = r.id
  and r.rn > 1;

-- 2. Swap the unique key: user-scoped → company-scoped.
alter table public.bank_file_imports
  drop constraint if exists bank_file_imports_user_id_file_hash_key;

alter table public.bank_file_imports
  drop constraint if exists bank_file_imports_company_id_file_hash_key;
alter table public.bank_file_imports
  add constraint bank_file_imports_company_id_file_hash_key
  unique (company_id, file_hash);

-- 3. Keep a plain lookup index for the old access pattern.
create index if not exists idx_bank_file_imports_user_hash
  on public.bank_file_imports(user_id, file_hash);

comment on constraint bank_file_imports_company_id_file_hash_key
  on public.bank_file_imports is
  'Dedup scope for bank-file imports: one import row per company and content hash. Replaces the single-tenant (user_id, file_hash) key.';

notify pgrst, 'reload schema';
