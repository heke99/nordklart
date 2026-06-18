-- Repairs the optional onboarding data model when an earlier product migration
-- was not applied to an existing production database. This migration is safe to
-- run repeatedly and preserves existing onboarding data.

create table if not exists public.onboarding_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  path text not null check (path in (
    'bookkeeping_direct',
    'bank_automation',
    'year_end_one_time',
    'bankgiro_autogiro',
    'agency_setup',
    'configure_later'
  )),
  status text not null default 'draft' check (status in ('draft', 'in_progress', 'completed', 'abandoned', 'blocked')),
  current_step text,
  progress_percent integer not null default 0 check (progress_percent between 0 and 100),
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.onboarding_steps (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.onboarding_sessions(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  step_code text not null,
  title text not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'completed', 'skipped', 'blocked')),
  sort_order integer not null default 100,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, step_code)
);

create table if not exists public.onboarding_choices (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.onboarding_sessions(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  choice_key text not null,
  choice_value text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (session_id, choice_key)
);

-- Existing installations may have the original four paths only. Expand the
-- constraint after the tables exist, rather than assuming a fresh schema.
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

create index if not exists idx_onboarding_sessions_company
  on public.onboarding_sessions(company_id, status);
create index if not exists idx_onboarding_sessions_user
  on public.onboarding_sessions(user_id, status);
create index if not exists idx_onboarding_steps_session_order
  on public.onboarding_steps(session_id, sort_order);
create index if not exists idx_onboarding_choices_session_key
  on public.onboarding_choices(session_id, choice_key);

alter table public.onboarding_sessions enable row level security;
alter table public.onboarding_steps enable row level security;
alter table public.onboarding_choices enable row level security;

grant select, insert, update, delete on public.onboarding_sessions, public.onboarding_steps, public.onboarding_choices to authenticated;

-- No policy is created unless the existing company-access resolver is present.
-- With RLS enabled, the safe fallback is deny-by-default rather than exposing
-- onboarding state while a broader access foundation is missing.
do $$
begin
  if to_regprocedure('public.user_can_access_company_v2(uuid)') is null then
    return;
  end if;

  execute 'drop policy if exists onboarding_sessions_company_select on public.onboarding_sessions';
  execute $policy$
    create policy onboarding_sessions_company_select on public.onboarding_sessions
    for select using (
      company_id is not null and public.user_can_access_company_v2(company_id)
    )
  $policy$;

  execute 'drop policy if exists onboarding_sessions_company_write on public.onboarding_sessions';
  execute $policy$
    create policy onboarding_sessions_company_write on public.onboarding_sessions
    for all using (
      company_id is not null and public.user_can_access_company_v2(company_id)
    ) with check (
      company_id is not null and public.user_can_access_company_v2(company_id)
    )
  $policy$;

  execute 'drop policy if exists onboarding_sessions_user_without_company on public.onboarding_sessions';
  execute $policy$
    create policy onboarding_sessions_user_without_company on public.onboarding_sessions
    for all using (company_id is null and user_id = auth.uid())
    with check (company_id is null and user_id = auth.uid())
  $policy$;

  execute 'drop policy if exists onboarding_steps_session_access on public.onboarding_steps';
  execute $policy$
    create policy onboarding_steps_session_access on public.onboarding_steps
    for all using (
      exists (
        select 1
        from public.onboarding_sessions os
        where os.id = onboarding_steps.session_id
          and (
            (os.company_id is null and os.user_id = auth.uid())
            or (os.company_id is not null and public.user_can_access_company_v2(os.company_id))
          )
      )
    ) with check (
      exists (
        select 1
        from public.onboarding_sessions os
        where os.id = onboarding_steps.session_id
          and (
            (os.company_id is null and os.user_id = auth.uid())
            or (os.company_id is not null and public.user_can_access_company_v2(os.company_id))
          )
      )
    )
  $policy$;

  execute 'drop policy if exists onboarding_choices_session_access on public.onboarding_choices';
  execute $policy$
    create policy onboarding_choices_session_access on public.onboarding_choices
    for all using (
      exists (
        select 1
        from public.onboarding_sessions os
        where os.id = onboarding_choices.session_id
          and (
            (os.company_id is null and os.user_id = auth.uid())
            or (os.company_id is not null and public.user_can_access_company_v2(os.company_id))
          )
      )
    ) with check (
      exists (
        select 1
        from public.onboarding_sessions os
        where os.id = onboarding_choices.session_id
          and (
            (os.company_id is null and os.user_id = auth.uid())
            or (os.company_id is not null and public.user_can_access_company_v2(os.company_id))
          )
      )
    )
  $policy$;
end;
$$;

-- Keep the timestamp lifecycle consistent with the rest of the application
-- when the shared helper is available.
do $$
begin
  if to_regprocedure('public.update_updated_at_column()') is null then
    return;
  end if;

  execute 'drop trigger if exists onboarding_sessions_updated_at on public.onboarding_sessions';
  execute 'create trigger onboarding_sessions_updated_at before update on public.onboarding_sessions for each row execute function public.update_updated_at_column()';
  execute 'drop trigger if exists onboarding_steps_updated_at on public.onboarding_steps';
  execute 'create trigger onboarding_steps_updated_at before update on public.onboarding_steps for each row execute function public.update_updated_at_column()';
end;
$$;

notify pgrst, 'reload schema';
