-- New terms after the change of supplier to Trafexa Nordic AB (556855-4884).
--
-- The contracting party changed, so the terms, the privacy policy and the
-- data processing agreement get new versions effective 2026-10-01. Existing
-- users accepted the 2026-06-27 versions, which named the previous supplier;
-- they must accept the new terms and privacy policy before they continue.
--
-- 1. The 2026-06-27 versions of terms, privacy_policy and dpa are retired and
--    2026-10-01 versions become active. Signup keeps recording acceptance of
--    whatever version is active, so new users accept the new texts.
-- 2. pending_legal_documents() lists the required documents (terms and
--    privacy policy) whose active version the calling user has not accepted.
--    SECURITY INVOKER: it reads through the existing RLS policies (versions
--    are public, acceptances are readable by their own user).
-- 3. accept_legal_documents() records acceptance of the given active
--    versions for a user. Service role only: the route authenticates the
--    user and supplies the IP address and user agent from the request.
--
-- pg-test: tests/pg/legal-reacceptance.pg.test.ts

-- ---------------------------------------------------------------------------
-- 1. New versions
-- ---------------------------------------------------------------------------
update public.legal_text_versions
   set is_active = false,
       retired_at = coalesce(retired_at, now()),
       updated_at = now()
 where document_type in ('terms', 'privacy_policy', 'dpa')
   and is_active
   and version <> '2026-10-01';

insert into public.legal_text_versions (document_type, version, title, public_path, is_active, effective_at, metadata)
values
  ('terms', '2026-10-01', 'Allmänna villkor', '/allmanna-villkor', true, '2026-10-01T00:00:00+02:00',
   '{"supplier":"Trafexa Nordic AB","org_number":"556855-4884","reason":"supplier_change"}'::jsonb),
  ('privacy_policy', '2026-10-01', 'Integritetspolicy', '/integritetspolicy', true, '2026-10-01T00:00:00+02:00',
   '{"supplier":"Trafexa Nordic AB","org_number":"556855-4884","reason":"supplier_change"}'::jsonb),
  ('dpa', '2026-10-01', 'Personuppgiftsbiträdesavtal', '/personuppgiftsbitradesavtal', true, '2026-10-01T00:00:00+02:00',
   '{"supplier":"Trafexa Nordic AB","org_number":"556855-4884","reason":"supplier_change"}'::jsonb)
on conflict (document_type, version) do update set
  is_active = true,
  retired_at = null,
  title = excluded.title,
  public_path = excluded.public_path,
  effective_at = excluded.effective_at,
  metadata = excluded.metadata,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. What the calling user still has to accept
-- ---------------------------------------------------------------------------
create or replace function public.pending_legal_documents()
returns table (
  legal_text_version_id uuid,
  document_type text,
  version text,
  title text,
  public_path text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select v.id, v.document_type, v.version, v.title, v.public_path
    from public.legal_text_versions v
   where v.is_active
     and v.document_type in ('terms', 'privacy_policy')
     and (select auth.uid()) is not null
     and not exists (
       select 1
         from public.legal_acceptances a
        where a.user_id = (select auth.uid())
          and a.legal_text_version_id = v.id
     )
   order by case v.document_type when 'terms' then 1 else 2 end;
$$;

revoke all on function public.pending_legal_documents() from public, anon;
grant execute on function public.pending_legal_documents() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Record acceptance
-- ---------------------------------------------------------------------------
create or replace function public.accept_legal_documents(
  p_user_id uuid,
  p_version_ids uuid[],
  p_source text default 'reacceptance',
  p_ip_address inet default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_accepted integer := 0;
  v_rejected integer;
  v_pending integer;
begin
  if p_user_id is null then
    raise exception 'user is required' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return jsonb_build_object('ok', false, 'error', 'user_not_found');
  end if;

  -- Only active versions can be accepted; a stale page (the version changed
  -- after it was rendered) must show the new text instead.
  select count(*) into v_rejected
    from unnest(coalesce(p_version_ids, '{}'::uuid[])) as ids(id)
   where not exists (
     select 1 from public.legal_text_versions v where v.id = ids.id and v.is_active
   );
  if v_rejected > 0 then
    return jsonb_build_object('ok', false, 'error', 'version_not_active');
  end if;

  insert into public.legal_acceptances
    (user_id, legal_text_version_id, document_type, source, ip_address, user_agent, metadata)
  select p_user_id, v.id, v.document_type, coalesce(nullif(p_source, ''), 'reacceptance'),
         p_ip_address, left(p_user_agent, 500),
         jsonb_build_object('version', v.version)
    from public.legal_text_versions v
   where v.is_active
     and v.id = any (coalesce(p_version_ids, '{}'::uuid[]))
  on conflict do nothing;
  get diagnostics v_accepted = row_count;

  select count(*) into v_pending
    from public.legal_text_versions v
   where v.is_active
     and v.document_type in ('terms', 'privacy_policy')
     and not exists (
       select 1 from public.legal_acceptances a
        where a.user_id = p_user_id and a.legal_text_version_id = v.id
     );

  return jsonb_build_object('ok', v_pending = 0, 'accepted', v_accepted, 'pending', v_pending,
                            'error', case when v_pending > 0 then 'documents_pending' end);
end;
$$;

revoke all on function public.accept_legal_documents(uuid, uuid[], text, inet, text) from public, anon, authenticated;
grant execute on function public.accept_legal_documents(uuid, uuid[], text, inet, text) to service_role;

comment on function public.accept_legal_documents(uuid, uuid[], text, inet, text) is
  'Records acceptance of active legal text versions. Service role only; callers authenticate the user first.';
