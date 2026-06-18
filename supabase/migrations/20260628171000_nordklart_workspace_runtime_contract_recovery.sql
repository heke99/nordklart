-- Runtime database-contract recovery.
--
-- The application must not depend on a partially applied staged release. These
-- functions are idempotent and restore the contracts used by onboarding,
-- invitations, account deletion and the accounting assistant.

create or replace function public.complete_core_onboarding(
  p_company_id uuid
)
returns table (
  company_id uuid,
  dashboard_href text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.user_can_access_company_v2(p_company_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.company_settings as cs
  set onboarding_complete = true,
      onboarding_step = greatest(coalesce(cs.onboarding_step, 1), 5),
      updated_at = now()
  where cs.company_id = p_company_id;

  update public.onboarding_steps as st
  set status = case
      when st.status = 'completed' then 'completed'
      else 'skipped'
    end,
    completed_at = coalesce(st.completed_at, now()),
    updated_at = now()
  where st.company_id = p_company_id
    and st.session_id in (
      select os.id
      from public.onboarding_sessions os
      where os.company_id = p_company_id
        and os.user_id = auth.uid()
        and os.status in ('draft', 'in_progress')
    );

  update public.onboarding_sessions as os
  set status = 'completed',
      current_step = 'dashboard',
      progress_percent = 100,
      completed_at = now(),
      metadata = os.metadata || jsonb_build_object('core_ready_at', now()),
      updated_at = now()
  where os.company_id = p_company_id
    and os.user_id = auth.uid()
    and os.status in ('draft', 'in_progress');

  insert into public.onboarding_choices as oc (
    session_id, company_id, choice_key, choice_value, metadata
  )
  select os.id, p_company_id, 'core_workspace_ready', 'true',
    jsonb_build_object('completed_by', auth.uid())
  from public.onboarding_sessions os
  where os.company_id = p_company_id
    and os.user_id = auth.uid()
    and os.status = 'completed'
  on conflict (session_id, choice_key) do update
    set choice_value = excluded.choice_value,
        metadata = excluded.metadata;

  return query select p_company_id, '/app'::text;
end;
$$;

revoke all on function public.complete_core_onboarding(uuid) from public;
grant execute on function public.complete_core_onboarding(uuid) to authenticated;

-- The invite endpoint calls this with a service-role client. Keeping execute
-- private prevents an authenticated caller from using it for email enumeration.
create or replace function public.check_email_exists(email_to_check text)
returns boolean
language sql
stable
security definer
set search_path = auth, public
as $$
  select exists (
    select 1
    from auth.users
    where lower(email) = lower(trim(email_to_check))
  );
$$;

revoke all on function public.check_email_exists(text) from public;
grant execute on function public.check_email_exists(text) to service_role;

-- Optional assistant context. The ledger may be introduced after the
-- workspace/onboarding rollout, so this function must remain callable while
-- returning an empty result until the required multi-tenant ledger schema exists.
-- Dynamic SQL deliberately prevents CREATE FUNCTION from resolving absent tables.
create or replace function public.agent_top_accounts_for_company(
  p_company_id uuid,
  p_limit integer default 20
)
returns table (
  account_number text,
  abs_amount numeric
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if to_regclass('public.journal_entry_lines') is null
     or to_regclass('public.journal_entries') is null
     or not exists (
       select 1
       from pg_attribute
       where attrelid = 'public.journal_entries'::regclass
         and attname = 'company_id'
         and not attisdropped
     ) then
    return;
  end if;

  return query execute $sql$
    select
      jel.account_number::text,
      sum(abs(coalesce(jel.debit_amount, 0) - coalesce(jel.credit_amount, 0)))::numeric as abs_amount
    from public.journal_entry_lines jel
    join public.journal_entries je on je.id = jel.journal_entry_id
    where je.company_id = $1
      and je.status = 'posted'
    group by jel.account_number
    order by abs_amount desc, jel.account_number asc
    limit least(greatest(coalesce($2, 20), 1), 100)
  $sql$
  using p_company_id, p_limit;
end;
$$;

revoke all on function public.agent_top_accounts_for_company(uuid, integer) from public;
grant execute on function public.agent_top_accounts_for_company(uuid, integer) to authenticated;

-- Retain accounting/audit rows and the auth user as a banned tombstone, but
-- remove the user's memberships and direct profile identifiers. The route
-- subsequently clears auth metadata, bans the user and terminates sessions.
create or replace function public.anonymize_user_account(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is distinct from target_user_id then
    raise exception 'Can only anonymize your own account' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.company_members cm
    join public.companies c on c.id = cm.company_id
    where cm.user_id = target_user_id
      and cm.role = 'owner'
      and c.archived_at is null
  ) then
    raise exception 'Active companies must be transferred or archived first' using errcode = 'P0001';
  end if;

  delete from public.user_preferences where user_id = target_user_id;
  delete from public.company_members where user_id = target_user_id;

  if to_regclass('public.agency_members') is not null then
    execute 'delete from public.agency_members where user_id = $1' using target_user_id;
  end if;

  if to_regclass('public.team_members') is not null then
    execute 'delete from public.team_members where user_id = $1' using target_user_id;
  end if;

  if to_regclass('public.bankid_enrichment') is not null then
    execute 'delete from public.bankid_enrichment where user_id = $1' using target_user_id;
  end if;

  if to_regclass('public.extension_data') is not null then
    execute $sql$
      delete from public.extension_data
      where user_id = $1
        and key = 'bankid_enrichment'
    $sql$ using target_user_id;
  end if;

  update public.profiles
  set email = null,
      full_name = null,
      avatar_url = null,
      updated_at = now()
  where id = target_user_id;
end;
$$;

revoke all on function public.anonymize_user_account(uuid) from public;
grant execute on function public.anonymize_user_account(uuid) to authenticated;
