-- Nordklart auth/legal account flow hardening.
-- Adds versioned legal acceptances, auth audit events, reusable email templates
-- and a signup trigger that preserves onboarding intent without touching posted bookkeeping.

create table if not exists public.legal_text_versions (
  id uuid primary key default gen_random_uuid(),
  document_type text not null check (document_type in ('terms','privacy_policy','cookies','dpa','withdrawal','year_end_terms')),
  version text not null,
  title text not null,
  public_path text not null,
  content_sha256 text,
  is_active boolean not null default false,
  effective_at timestamptz not null default now(),
  retired_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_type, version)
);

create unique index if not exists legal_text_versions_one_active_per_type
  on public.legal_text_versions(document_type)
  where is_active;

create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  company_id uuid references public.companies(id) on delete cascade,
  legal_text_version_id uuid not null references public.legal_text_versions(id) on delete restrict,
  document_type text not null,
  source text not null default 'register',
  accepted_at timestamptz not null default now(),
  ip_address inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists legal_acceptances_user_version_no_company_idx
  on public.legal_acceptances(user_id, legal_text_version_id)
  where company_id is null and user_id is not null;
create unique index if not exists legal_acceptances_user_company_version_idx
  on public.legal_acceptances(user_id, company_id, legal_text_version_id)
  where company_id is not null and user_id is not null;
create index if not exists legal_acceptances_company_idx on public.legal_acceptances(company_id, accepted_at desc);

create table if not exists public.auth_audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  email text,
  event_type text not null,
  status text not null default 'success' check (status in ('success','accepted','failed','blocked')),
  ip_address inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists auth_audit_events_user_idx on public.auth_audit_events(user_id, created_at desc);
create index if not exists auth_audit_events_email_idx on public.auth_audit_events(lower(email), created_at desc);
create index if not exists auth_audit_events_type_idx on public.auth_audit_events(event_type, created_at desc);

create table if not exists public.email_templates (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text not null default 'account',
  subject text not null,
  preview_text text,
  body_html text not null,
  body_text text not null,
  cta_label text,
  cta_url text,
  status text not null default 'active' check (status in ('active','draft','paused','archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

update public.legal_text_versions
set is_active = false, updated_at = now()
where document_type in ('terms','privacy_policy','cookies','dpa','withdrawal','year_end_terms');

insert into public.legal_text_versions (document_type, version, title, public_path, is_active, metadata)
values
  ('terms', '2026-06-27', 'Allmänna villkor', '/allmanna-villkor', true, '{"source":"auth_legal_batch"}'::jsonb),
  ('privacy_policy', '2026-06-27', 'Integritetspolicy', '/integritetspolicy', true, '{"source":"auth_legal_batch"}'::jsonb),
  ('cookies', '2026-06-27', 'Cookies', '/cookies', true, '{"source":"auth_legal_batch"}'::jsonb),
  ('dpa', '2026-06-27', 'Personuppgiftsbiträdesavtal', '/personuppgiftsbitradesavtal', true, '{"source":"auth_legal_batch"}'::jsonb),
  ('withdrawal', '2026-06-27', 'Ångerrätt', '/angerratt', true, '{"source":"auth_legal_batch"}'::jsonb),
  ('year_end_terms', '2026-06-27', 'Villkor för bokslut', '/bokslut/villkor', true, '{"source":"auth_legal_batch"}'::jsonb)
on conflict (document_type, version) do update set
  title = excluded.title,
  public_path = excluded.public_path,
  is_active = excluded.is_active,
  metadata = excluded.metadata,
  updated_at = now();

insert into public.email_templates (code, name, category, subject, preview_text, body_html, body_text, cta_label, cta_url, metadata)
values
  ('auth.email_confirmation', 'Bekräfta e-post', 'auth', 'Bekräfta din e-postadress', 'Bekräfta ditt Nordklart-konto.', '<p>Välkommen till Nordklart. Bekräfta din e-postadress för att fortsätta.</p><p><a href="{{ confirmation_url }}">Bekräfta e-post</a></p>', 'Välkommen till Nordklart. Bekräfta din e-postadress: {{ confirmation_url }}', 'Bekräfta e-post', '{{ confirmation_url }}', '{"tokens":["confirmation_url"]}'::jsonb),
  ('auth.password_reset', 'Återställ lösenord', 'auth', 'Återställ ditt lösenord', 'Använd länken för att välja ett nytt lösenord.', '<p>Du har begärt att återställa lösenordet till Nordklart.</p><p><a href="{{ reset_url }}">Välj nytt lösenord</a></p>', 'Återställ ditt lösenord: {{ reset_url }}', 'Välj nytt lösenord', '{{ reset_url }}', '{"tokens":["reset_url"]}'::jsonb),
  ('auth.invitation', 'Inbjudan', 'auth', 'Du har blivit inbjuden till Nordklart', 'Skapa ditt lösenord och anslut till bolaget.', '<p>Du har blivit inbjuden till Nordklart.</p><p><a href="{{ invite_url }}">Acceptera inbjudan</a></p>', 'Du har blivit inbjuden till Nordklart: {{ invite_url }}', 'Acceptera inbjudan', '{{ invite_url }}', '{"tokens":["invite_url"]}'::jsonb),
  ('account.created', 'Välkommen', 'account', 'Välkommen till Nordklart', 'Ditt konto är skapat.', '<p>Ditt Nordklart-konto är skapat. Fortsätt onboarding för att komma igång.</p><p><a href="{{ onboarding_url }}">Fortsätt onboarding</a></p>', 'Ditt Nordklart-konto är skapat. Fortsätt: {{ onboarding_url }}', 'Fortsätt onboarding', '{{ onboarding_url }}', '{"tokens":["onboarding_url"]}'::jsonb),
  ('onboarding.continue', 'Fortsätt onboarding', 'account', 'Fortsätt konfigurera Nordklart', 'Slutför bolagsuppgifter och nästa steg.', '<p>Fortsätt konfigurera bolaget i Nordklart.</p><p><a href="{{ onboarding_url }}">Fortsätt</a></p>', 'Fortsätt konfigurera Nordklart: {{ onboarding_url }}', 'Fortsätt', '{{ onboarding_url }}', '{"tokens":["onboarding_url"]}'::jsonb),
  ('agency.client_invited', 'Byrå kundinbjudan', 'agency', 'Din redovisningsbyrå har bjudit in dig', 'Skapa konto och anslut till kundbolaget.', '<p>Din redovisningsbyrå har bjudit in dig till Nordklart.</p><p><a href="{{ invite_url }}">Skapa konto</a></p>', 'Din byrå har bjudit in dig: {{ invite_url }}', 'Skapa konto', '{{ invite_url }}', '{"tokens":["invite_url"]}'::jsonb),
  ('password.changed', 'Lösenord ändrat', 'security', 'Ditt lösenord har ändrats', 'Kontakta oss om det inte var du.', '<p>Ditt lösenord i Nordklart har ändrats.</p><p>Kontakta oss direkt om det inte var du.</p>', 'Ditt lösenord i Nordklart har ändrats. Kontakta oss om det inte var du.', null, null, '{}'::jsonb),
  ('security.login_alert', 'Login-varning', 'security', 'Ny inloggning i Nordklart', 'Vi upptäckte en ny inloggning.', '<p>Vi upptäckte en ny inloggning i Nordklart.</p>', 'Vi upptäckte en ny inloggning i Nordklart.', null, null, '{"planned":true}'::jsonb)
on conflict (code) do update set
  name = excluded.name,
  category = excluded.category,
  subject = excluded.subject,
  preview_text = excluded.preview_text,
  body_html = excluded.body_html,
  body_text = excluded.body_text,
  cta_label = excluded.cta_label,
  cta_url = excluded.cta_url,
  status = excluded.status,
  metadata = excluded.metadata,
  updated_at = now();


-- The original core migration creates a profile trigger on auth.users. Keep it
-- idempotent so later auth/signup triggers can safely enrich the same row.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do update set
    email = excluded.email,
    full_name = coalesce(nullif(public.profiles.full_name, ''), excluded.full_name),
    updated_at = now();
  return new;
end;
$$ language plpgsql security definer;

create or replace function public.nordklart_handle_auth_signup_context()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta jsonb;
  v_full_name text;
  v_flow text;
  v_session_id uuid;
  v_terms_id uuid;
  v_privacy_id uuid;
begin
  v_meta := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_full_name := nullif(trim(coalesce(v_meta->>'full_name', concat_ws(' ', v_meta->>'first_name', v_meta->>'last_name'))), '');
  v_flow := nullif(v_meta->>'onboarding_flow', '');
  if v_full_name is not null then
    insert into public.profiles (id, email, full_name)
    values (new.id, new.email, v_full_name)
    on conflict (id) do update set
      email = excluded.email,
      full_name = coalesce(nullif(public.profiles.full_name, ''), excluded.full_name),
      updated_at = now();
  end if;

  insert into public.auth_audit_events (user_id, email, event_type, status, user_agent, metadata)
  values (
    new.id,
    new.email,
    'account_created',
    'success',
    v_meta->>'legal_acceptance_user_agent',
    jsonb_build_object(
      'onboarding_intent', v_meta->>'onboarding_intent',
      'onboarding_flow', v_flow,
      'company_name', v_meta->>'company_name'
    )
  );

  if v_flow in ('bookkeeping_direct','bank_automation','year_end_one_time','bankgiro_autogiro') then
    insert into public.onboarding_sessions (company_id, user_id, path, status, current_step, progress_percent, metadata)
    values (
      null,
      new.id,
      v_flow,
      'draft',
      case v_flow
        when 'bookkeeping_direct' then 'company'
        when 'bank_automation' then 'bank'
        when 'year_end_one_time' then 'import'
        when 'bankgiro_autogiro' then 'business_profile'
      end,
      0,
      jsonb_build_object('source','register','intent',v_meta->>'onboarding_intent','company_name',v_meta->>'company_name')
    )
    returning id into v_session_id;

    if v_flow = 'bookkeeping_direct' then
      insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, null, 'company', 'Bolagsuppgifter', 10),
        (v_session_id, null, 'fiscal_year', 'Räkenskapsår', 20),
        (v_session_id, null, 'vat_period', 'Momsperiod', 30),
        (v_session_id, null, 'plan', 'Välj prisplan', 40),
        (v_session_id, null, 'dashboard', 'Klar för översikt', 50)
      on conflict (session_id, step_code) do nothing;
    elsif v_flow = 'bank_automation' then
      insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, null, 'company', 'Skapa bolag', 10),
        (v_session_id, null, 'bank', 'Koppla bank', 20),
        (v_session_id, null, 'transactions', 'Importera transaktioner', 30),
        (v_session_id, null, 'rules', 'Bekräfta regler', 40),
        (v_session_id, null, 'review', 'Granskning', 50)
      on conflict (session_id, step_code) do nothing;
    elsif v_flow = 'year_end_one_time' then
      insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, null, 'import', 'Importera SIE', 10),
        (v_session_id, null, 'fiscal_year', 'Välj räkenskapsår', 20),
        (v_session_id, null, 'analysis', 'Bokslutskontroller', 30),
        (v_session_id, null, 'payment', 'Engångsköp', 40),
        (v_session_id, null, 'export', 'Exportpaket', 50)
      on conflict (session_id, step_code) do nothing;
    elsif v_flow = 'bankgiro_autogiro' then
      insert into public.onboarding_steps (session_id, company_id, step_code, title, sort_order) values
        (v_session_id, null, 'business_profile', 'Bolagsuppgifter', 10),
        (v_session_id, null, 'owners', 'Ägare och verklig huvudman', 20),
        (v_session_id, null, 'usage', 'Användningsområde och volym', 30),
        (v_session_id, null, 'documents', 'Dokument', 40),
        (v_session_id, null, 'review', 'Superadmin review', 50),
        (v_session_id, null, 'provider_setup', 'Provider setup', 60)
      on conflict (session_id, step_code) do nothing;
    end if;
  end if;

  if coalesce((v_meta->>'accepted_terms')::boolean, false) then
    select id into v_terms_id from public.legal_text_versions where document_type = 'terms' and is_active order by effective_at desc limit 1;
    if v_terms_id is not null then
      insert into public.legal_acceptances (user_id, legal_text_version_id, document_type, source, user_agent, metadata)
      values (new.id, v_terms_id, 'terms', coalesce(v_meta->>'legal_acceptance_source','register'), v_meta->>'legal_acceptance_user_agent', jsonb_build_object('accepted_terms', true))
      on conflict do nothing;
    end if;
  end if;

  if coalesce((v_meta->>'accepted_privacy')::boolean, false) then
    select id into v_privacy_id from public.legal_text_versions where document_type = 'privacy_policy' and is_active order by effective_at desc limit 1;
    if v_privacy_id is not null then
      insert into public.legal_acceptances (user_id, legal_text_version_id, document_type, source, user_agent, metadata)
      values (new.id, v_privacy_id, 'privacy_policy', coalesce(v_meta->>'legal_acceptance_source','register'), v_meta->>'legal_acceptance_user_agent', jsonb_build_object('accepted_privacy', true))
      on conflict do nothing;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists nordklart_auth_signup_context on auth.users;
drop trigger if exists zz_nordklart_auth_signup_context on auth.users;
create trigger zz_nordklart_auth_signup_context
  after insert on auth.users
  for each row execute function public.nordklart_handle_auth_signup_context();

alter table public.legal_text_versions enable row level security;
alter table public.legal_acceptances enable row level security;
alter table public.auth_audit_events enable row level security;
alter table public.email_templates enable row level security;

drop policy if exists legal_text_versions_public_read on public.legal_text_versions;
create policy legal_text_versions_public_read on public.legal_text_versions
  for select using (true);

drop policy if exists legal_acceptances_own_read on public.legal_acceptances;
create policy legal_acceptances_own_read on public.legal_acceptances
  for select using (user_id = auth.uid() or public.is_platform_admin() or (company_id is not null and public.user_can_access_company_v2(company_id)));

drop policy if exists legal_acceptances_service_insert on public.legal_acceptances;
create policy legal_acceptances_service_insert on public.legal_acceptances
  for insert with check (user_id = auth.uid() or public.is_platform_admin());

drop policy if exists auth_audit_events_own_read on public.auth_audit_events;
create policy auth_audit_events_own_read on public.auth_audit_events
  for select using (user_id = auth.uid() or public.is_platform_admin() or (company_id is not null and public.user_can_access_company_v2(company_id)));

drop policy if exists email_templates_authenticated_read on public.email_templates;
create policy email_templates_authenticated_read on public.email_templates
  for select using (auth.uid() is not null or status = 'active');

drop policy if exists email_templates_admin_write on public.email_templates;
create policy email_templates_admin_write on public.email_templates
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

do $$
declare
  t text;
begin
  foreach t in array array['legal_text_versions','email_templates'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.update_updated_at_column()', t || '_updated_at', t);
  end loop;
end $$;

notify pgrst, 'reload schema';
