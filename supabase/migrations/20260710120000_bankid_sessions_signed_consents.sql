-- Batch 6 — BankID signing & consents data model.
--
-- 1. bankid_sessions: one row per BankID auth/sign attempt started from
--    Nordklart (login sessions handled purely client-side by TIC remain
--    outside; this table covers consent/signing/verification flows where a
--    durable, auditable session record is required).
--
-- 2. signed_consents: BankID-verified consents (samtycken) — agency data
--    sharing, bank connection, Skatteverket flows, invoice financing,
--    API/integrations, Bankgiro/Autogiro applications. The consent text
--    shown to the user is stored verbatim; the signer is recorded as a
--    personnummer hash + masked display value (PII isolation — plaintext
--    personnummer is never stored).
--
-- 3. user_identity_verifications: BankID identity-verification events per
--    user (onboarding identity check, re-verification).
--
-- All tables: RLS, company/user scope, indexes. Signed consents are
-- immutable apart from revocation (status flip) — enforced by trigger.

-- ── 1. bankid_sessions ───────────────────────────────────────────────────────

create table if not exists public.bankid_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid null references public.companies(id) on delete cascade,

  provider text not null default 'tic' check (provider in ('tic', 'mock')),
  provider_mode text not null default 'production' check (provider_mode in ('test', 'production')),
  -- The provider's own session reference (TIC sessionId).
  provider_session_ref text not null,

  purpose text not null check (purpose in ('auth', 'sign', 'identity_verification', 'consent')),
  -- What the user was asked to sign/consent to (verbatim, for sign/consent).
  sign_text text null,
  -- Flow context, e.g. { kind: 'arsredovisning_signature', signature_request_id }
  context jsonb not null default '{}'::jsonb,

  status text not null default 'pending'
    check (status in ('pending', 'complete', 'failed', 'cancelled', 'expired')),
  hint_code text null,

  -- Completion data (never plaintext personnummer).
  personal_number_hash text null,
  personal_number_masked text null,
  signer_name text null,
  completed_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bankid_sessions_user
  on public.bankid_sessions (user_id, created_at desc);
create index if not exists idx_bankid_sessions_company
  on public.bankid_sessions (company_id, created_at desc)
  where company_id is not null;
create index if not exists idx_bankid_sessions_provider_ref
  on public.bankid_sessions (provider_session_ref);

alter table public.bankid_sessions enable row level security;

drop policy if exists bankid_sessions_select on public.bankid_sessions;
create policy bankid_sessions_select on public.bankid_sessions
  for select using (user_id = auth.uid());

drop policy if exists bankid_sessions_insert on public.bankid_sessions;
create policy bankid_sessions_insert on public.bankid_sessions
  for insert with check (user_id = auth.uid());

drop policy if exists bankid_sessions_update on public.bankid_sessions;
create policy bankid_sessions_update on public.bankid_sessions
  for update using (user_id = auth.uid());

comment on table public.bankid_sessions is
  'BankID auth/sign session records for consent, signing and identity-verification flows. Personnummer stored only as hash + mask.';

-- ── 2. signed_consents ───────────────────────────────────────────────────────

create table if not exists public.signed_consents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,

  consent_type text not null check (consent_type in (
    'agency_data_sharing',
    'bank_connection',
    'skatteverket',
    'invoice_financing',
    'api_integration',
    'bankgiro_autogiro',
    'arsredovisning_signature',
    'other'
  )),
  title text not null,
  -- The exact text presented to and confirmed by the signer.
  consent_text text not null,

  signed_via text not null default 'bankid' check (signed_via in ('bankid', 'password')),
  bankid_session_id uuid null references public.bankid_sessions(id) on delete set null,
  personal_number_hash text null,
  personal_number_masked text null,
  signer_name text null,

  status text not null default 'active' check (status in ('active', 'revoked')),
  revoked_at timestamptz null,
  revoked_by uuid null references auth.users(id) on delete set null,

  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_signed_consents_company
  on public.signed_consents (company_id, consent_type, status);
create index if not exists idx_signed_consents_user
  on public.signed_consents (user_id, created_at desc);

alter table public.signed_consents enable row level security;

drop policy if exists signed_consents_select on public.signed_consents;
create policy signed_consents_select on public.signed_consents
  for select using (
    public.user_can_access_company_v2(company_id) or public.is_platform_admin()
  );

drop policy if exists signed_consents_insert on public.signed_consents;
create policy signed_consents_insert on public.signed_consents
  for insert with check (
    user_id = auth.uid() and public.user_can_access_company_v2(company_id)
  );

drop policy if exists signed_consents_update on public.signed_consents;
create policy signed_consents_update on public.signed_consents
  for update using (
    public.user_can_access_company_v2(company_id)
  );

-- Immutability: a signed consent is evidence. Only the revocation fields may
-- change after signing; everything else is frozen. Deletes are blocked.
create or replace function public.signed_consents_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Signerade samtycken får inte raderas — återkalla i stället (status=revoked).';
  end if;
  if old.consent_text is distinct from new.consent_text
     or old.consent_type is distinct from new.consent_type
     or old.title is distinct from new.title
     or old.personal_number_hash is distinct from new.personal_number_hash
     or old.signed_via is distinct from new.signed_via
     or old.bankid_session_id is distinct from new.bankid_session_id
     or old.company_id is distinct from new.company_id
     or old.user_id is distinct from new.user_id
     or old.created_at is distinct from new.created_at then
    raise exception 'Signerade samtycken är oföränderliga — endast återkallelse (status/revoked_at/revoked_by) kan ändras.';
  end if;
  return new;
end;
$$;

drop trigger if exists signed_consents_no_delete on public.signed_consents;
create trigger signed_consents_no_delete
  before delete on public.signed_consents
  for each row execute function public.signed_consents_immutable();

drop trigger if exists signed_consents_no_mutate on public.signed_consents;
create trigger signed_consents_no_mutate
  before update on public.signed_consents
  for each row execute function public.signed_consents_immutable();

comment on table public.signed_consents is
  'BankID-verified consents (agency access, bank connection, SKV, financing, API, Bankgiro). Immutable except revocation; never deleted.';

-- ── 3. user_identity_verifications ──────────────────────────────────────────

create table if not exists public.user_identity_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'tic' check (provider in ('tic', 'mock')),
  bankid_session_id uuid null references public.bankid_sessions(id) on delete set null,
  personal_number_hash text not null,
  personal_number_masked text not null,
  verified_name text null,
  verified_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_identity_verifications_user
  on public.user_identity_verifications (user_id, verified_at desc);

alter table public.user_identity_verifications enable row level security;

drop policy if exists user_identity_verifications_select on public.user_identity_verifications;
create policy user_identity_verifications_select on public.user_identity_verifications
  for select using (user_id = auth.uid());

drop policy if exists user_identity_verifications_insert on public.user_identity_verifications;
create policy user_identity_verifications_insert on public.user_identity_verifications
  for insert with check (user_id = auth.uid());

comment on table public.user_identity_verifications is
  'BankID identity-verification events per user. Personnummer stored only as hash + mask.';

NOTIFY pgrst, 'reload schema';
