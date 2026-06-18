-- Workspace navigation recovery.
-- Ensures optional onboarding path selection is available after deploying the
-- dashboard/onboarding code, including databases that missed the original
-- flexible-onboarding migration during a staged release.

alter table public.onboarding_sessions
  drop constraint if exists onboarding_sessions_path_check;

alter table public.onboarding_sessions
  add constraint onboarding_sessions_path_check
  check (path in (
    'bookkeeping_direct',
    'bank_automation',
    'year_end_one_time',
    'bankgiro_autogiro',
    'agency_setup',
    'configure_later'
  ));

create or replace function public.select_onboarding_start_path(
  p_company_id uuid,
  p_path text
)
returns table (
  session_id uuid,
  path text,
  next_href text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_path text := lower(trim(coalesce(p_path, 'configure_later')));
  v_next_href text;
begin
  if auth.uid() is null or not public.user_can_access_company_v2(p_company_id) then
    raise exception 'not allowed';
  end if;

  if v_path not in (
    'bookkeeping_direct',
    'bank_automation',
    'year_end_one_time',
    'bankgiro_autogiro',
    'agency_setup',
    'configure_later'
  ) then
    raise exception 'invalid onboarding path';
  end if;

  select os.id
    into v_session_id
  from public.onboarding_sessions os
  where os.company_id = p_company_id
    and os.user_id = auth.uid()
    and os.status in ('draft', 'in_progress')
  order by os.updated_at desc
  limit 1
  for update;

  if v_session_id is null then
    insert into public.onboarding_sessions as os (
      company_id, user_id, path, status, current_step, progress_percent, metadata
    )
    values (
      p_company_id, auth.uid(), v_path, 'in_progress', 'start', 20,
      jsonb_build_object('source', 'dashboard_start_choice')
    )
    returning os.id into v_session_id;
  else
    update public.onboarding_sessions as os
    set path = v_path,
        current_step = 'start',
        progress_percent = greatest(os.progress_percent, 20),
        metadata = os.metadata || jsonb_build_object('selected_path_at', now()),
        updated_at = now()
    where os.id = v_session_id;

    update public.onboarding_steps as st
    set status = 'skipped',
        updated_at = now()
    where st.session_id = v_session_id
      and st.status in ('pending', 'active');
  end if;

  insert into public.onboarding_choices as oc (
    session_id, company_id, choice_key, choice_value, metadata
  )
  values (
    v_session_id, p_company_id, 'starting_path', v_path,
    jsonb_build_object('selected_by', auth.uid())
  )
  on conflict (session_id, choice_key) do update
    set choice_value = excluded.choice_value,
        metadata = excluded.metadata;

  v_next_href := case v_path
    when 'bank_automation' then '/bank-automation'
    when 'year_end_one_time' then '/year-end'
    when 'bankgiro_autogiro' then '/payments/bankgiro'
    when 'agency_setup' then '/agency'
    else '/app'
  end;

  return query select v_session_id, v_path, v_next_href;
end;
$$;

revoke all on function public.select_onboarding_start_path(uuid, text) from public;
grant execute on function public.select_onboarding_start_path(uuid, text) to authenticated;
