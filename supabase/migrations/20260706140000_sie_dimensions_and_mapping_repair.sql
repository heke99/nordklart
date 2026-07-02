-- ── SIE dimensions on journal lines + mapping tenant-key repair ──────────────
--
-- 1. journal_entry_lines.dimensions: full SIE dimension→objektkod map from a
--    #TRANS object list. Dimension 1 (kostnadsställe) and 6 (projekt) also
--    land in the existing cost_center/project columns; the jsonb map preserves
--    non-standard dimensions for round-trip export fidelity.
--
-- 2. sie_account_mappings repair: POST /api/import/sie/mappings (and the two
--    provider-migration extensions) used to call saveMappings with user.id in
--    the companyId parameter, storing rows with company_id = <a user id>.
--    Those rows are invisible to every reader (which filter by real company
--    ids) and merely squat the (company_id, source_account) key. Where the
--    user has EXACTLY ONE company membership the intended tenant is
--    unambiguous — remap. Ambiguous rows (multi-company users) are deleted:
--    they were never readable, and mappings are regenerated on the next
--    import preview anyway.
--
-- Safe to run once: guarded DDL; the repair UPDATE/DELETE only touches rows
-- whose company_id matches an auth.users id (never a real companies id).

alter table public.journal_entry_lines
  add column if not exists dimensions jsonb;

comment on column public.journal_entry_lines.dimensions is
  'SIE dimension→objektkod map from the imported #TRANS object list (e.g. {"1":"100","6":"P1"}). Dimensions 1/6 are also denormalized into cost_center/project.';

-- 2a. Remap rows whose company_id is actually a user id, when that user has
--     exactly one company membership.
with misfiled as (
  select m.id, m.company_id as user_key
  from public.sie_account_mappings m
  where not exists (select 1 from public.companies c where c.id = m.company_id)
    and exists (select 1 from auth.users u where u.id = m.company_id)
),
single_membership as (
  select cm.user_id, min(cm.company_id::text)::uuid as company_id
  from public.company_members cm
  group by cm.user_id
  having count(distinct cm.company_id) = 1
)
update public.sie_account_mappings m
set company_id = s.company_id
from misfiled f
join single_membership s on s.user_id = f.user_key
where m.id = f.id
  -- Don't collide with an existing correctly-keyed mapping.
  and not exists (
    select 1 from public.sie_account_mappings m2
    where m2.company_id = s.company_id
      and m2.source_account = m.source_account
      and m2.id <> m.id
  );

-- 2b. Delete the remaining unreachable rows (ambiguous multi-company users or
--     collisions). They were never readable by any code path.
delete from public.sie_account_mappings m
where not exists (select 1 from public.companies c where c.id = m.company_id)
  and exists (select 1 from auth.users u where u.id = m.company_id);

notify pgrst, 'reload schema';
