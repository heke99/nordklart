-- API key and session lifecycle.
--
-- 1. An API key kept working after its user lost access: the MCP server runs
--    every tool with the service role against the key's company_id, and
--    validate_and_increment_api_key only checked revoked_at. A removed
--    employee (or a deleted account) kept read/write access to the books, and
--    the OAuth refresh grant kept renewing it. The key check now also
--    requires the user to still reach the company (resolve_company_access_
--    for_user), the account not to be banned or deleted, and the key not to
--    be past expires_at.
-- 2. OAuth-minted keys get a server-side lifetime and their refresh tokens a
--    sliding lifetime. rotate_api_key_refresh() rotates both atomically,
--    re-checks access, and treats reuse of an already-rotated refresh token
--    as theft: the key is revoked.
-- 3. Removing, revoking or suspending a company membership revokes that
--    user's keys for the company (this also covers anonymize_user_account,
--    which deletes the memberships).
-- 4. revoke_user_sessions() ends a user's Supabase sessions (optionally all
--    but the current one), for account deletion, password change and
--    "sign out everywhere".
--
-- pg-test: tests/pg/api-keys-lifecycle.pg.test.ts

alter table public.api_keys
  add column if not exists expires_at timestamptz,
  add column if not exists refresh_expires_at timestamptz,
  add column if not exists previous_refresh_token_hash text;

comment on column public.api_keys.expires_at is
  'Server-side expiry of the key; null for user-managed keys that live until revoked.';
comment on column public.api_keys.refresh_expires_at is
  'Sliding expiry of the OAuth refresh token; extended on every rotation.';
comment on column public.api_keys.previous_refresh_token_hash is
  'Hash of the refresh token that was rotated out. Presenting it again revokes the key.';

create index if not exists idx_api_keys_previous_refresh_token_hash
  on public.api_keys (previous_refresh_token_hash)
  where previous_refresh_token_hash is not null;

-- ---------------------------------------------------------------------------
-- Is the key's owner still allowed to use it?
-- ---------------------------------------------------------------------------
create or replace function public.api_key_owner_is_active(p_user_id uuid, p_company_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user jsonb;
begin
  -- to_jsonb keeps this working on auth schemas without banned_until/deleted_at.
  select to_jsonb(u) into v_user from auth.users u where u.id = p_user_id;
  if v_user is null then
    return false;
  end if;
  if nullif(v_user ->> 'deleted_at', '') is not null then
    return false;
  end if;
  if nullif(v_user ->> 'banned_until', '') is not null
     and (v_user ->> 'banned_until')::timestamptz > now() then
    return false;
  end if;
  return exists (
    select 1 from public.resolve_company_access_for_user(p_user_id, p_company_id) a
     where a.can_read
  );
end;
$$;

revoke all on function public.api_key_owner_is_active(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_key_owner_is_active(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- validate_and_increment_api_key: previous body (20260512162506) restated,
-- plus expiry and owner checks before the rate-limit counter is touched.
-- ---------------------------------------------------------------------------
create or replace function public.validate_and_increment_api_key(p_key_hash text)
returns table(user_id uuid, company_id uuid, api_key_id uuid, api_key_name text, rate_limited boolean, scopes text[], mode text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_user_id uuid;
  v_company_id uuid;
  v_api_key_id uuid;
  v_api_key_name text;
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
  v_scopes text[];
  v_mode text;
  v_expires_at timestamptz;
begin
  select ak.user_id, ak.company_id, ak.id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes, ak.mode,
         ak.expires_at
  into v_user_id, v_company_id, v_api_key_id, v_api_key_name,
       v_rate_limit_rpm, v_request_count, v_window_start, v_scopes, v_mode,
       v_expires_at
  from public.api_keys ak
  where ak.key_hash = p_key_hash and ak.revoked_at is null
  for update;

  if v_user_id is null then
    return;
  end if;

  if v_expires_at is not null and v_expires_at <= now() then
    return;
  end if;

  if not public.api_key_owner_is_active(v_user_id, v_company_id) then
    return;
  end if;

  if v_window_start is null or v_window_start < now() - interval '1 minute' then
    update public.api_keys
    set request_count = 1,
        rate_limit_window_start = now(),
        last_used_at = now()
    where key_hash = p_key_hash;

    return query select v_user_id, v_company_id, v_api_key_id, v_api_key_name, false, v_scopes, v_mode;
    return;
  end if;

  if v_request_count >= v_rate_limit_rpm then
    return query select v_user_id, v_company_id, v_api_key_id, v_api_key_name, true, v_scopes, v_mode;
    return;
  end if;

  update public.api_keys
  set request_count = request_count + 1,
      last_used_at = now()
  where key_hash = p_key_hash;

  return query select v_user_id, v_company_id, v_api_key_id, v_api_key_name, false, v_scopes, v_mode;
end;
$function$;

-- ---------------------------------------------------------------------------
-- OAuth refresh rotation
-- ---------------------------------------------------------------------------
create or replace function public.rotate_api_key_refresh(
  p_presented_refresh_hash text,
  p_new_refresh_hash text,
  p_new_key_hash text,
  p_new_key_prefix text,
  p_access_ttl interval default interval '24 hours',
  p_refresh_ttl interval default interval '60 days'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key public.api_keys%rowtype;
begin
  if p_presented_refresh_hash is null or p_new_refresh_hash is null or p_new_key_hash is null then
    raise exception 'hashes are required' using errcode = '22023';
  end if;

  select * into v_key from public.api_keys where refresh_token_hash = p_presented_refresh_hash for update;

  if not found then
    -- A refresh token that was already rotated out is being replayed: the
    -- legitimate client and an attacker now both hold one. Revoke the key.
    update public.api_keys
       set revoked_at = coalesce(revoked_at, now()), refresh_token_hash = null
     where previous_refresh_token_hash = p_presented_refresh_hash
       and revoked_at is null;
    if found then
      return jsonb_build_object('ok', false, 'error', 'refresh_token_reused');
    end if;
    return jsonb_build_object('ok', false, 'error', 'invalid_refresh_token');
  end if;

  if v_key.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;
  if v_key.refresh_expires_at is not null and v_key.refresh_expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'refresh_token_expired');
  end if;
  if not public.api_key_owner_is_active(v_key.user_id, v_key.company_id) then
    update public.api_keys
       set revoked_at = now(), refresh_token_hash = null
     where id = v_key.id;
    return jsonb_build_object('ok', false, 'error', 'access_revoked');
  end if;

  update public.api_keys
     set previous_refresh_token_hash = p_presented_refresh_hash,
         refresh_token_hash = p_new_refresh_hash,
         key_hash = p_new_key_hash,
         key_prefix = p_new_key_prefix,
         expires_at = now() + p_access_ttl,
         refresh_expires_at = now() + p_refresh_ttl
   where id = v_key.id;

  return jsonb_build_object('ok', true, 'api_key_id', v_key.id, 'scopes', to_jsonb(v_key.scopes));
end;
$$;

revoke all on function public.rotate_api_key_refresh(text, text, text, text, interval, interval) from public, anon, authenticated;
grant execute on function public.rotate_api_key_refresh(text, text, text, text, interval, interval) to service_role;

-- ---------------------------------------------------------------------------
-- Membership loss revokes keys
-- ---------------------------------------------------------------------------
create or replace function public.revoke_api_keys_on_membership_loss()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE'
     or (tg_op = 'UPDATE' and new.status in ('revoked', 'suspended') and old.status is distinct from new.status) then
    update public.api_keys
       set revoked_at = now(), refresh_token_hash = null
     where user_id = old.user_id
       and company_id = old.company_id
       and revoked_at is null;
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.revoke_api_keys_on_membership_loss() from public, anon, authenticated;

drop trigger if exists revoke_api_keys_on_membership_loss on public.company_members;
create trigger revoke_api_keys_on_membership_loss
  after update of status or delete on public.company_members
  for each row execute function public.revoke_api_keys_on_membership_loss();

-- ---------------------------------------------------------------------------
-- Session revocation
-- ---------------------------------------------------------------------------
create or replace function public.revoke_user_sessions(p_user_id uuid, p_keep_session_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  if p_user_id is null then
    raise exception 'user is required' using errcode = '22023';
  end if;
  -- Guarded so the function also installs on auth schemas without sessions.
  if to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id = $1 and ($2::uuid is null or id <> $2)'
      using p_user_id, p_keep_session_id;
    get diagnostics v_count = row_count;
  end if;
  if to_regclass('auth.refresh_tokens') is not null then
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'auth' and table_name = 'refresh_tokens' and column_name = 'session_id'
    ) then
      execute 'delete from auth.refresh_tokens where user_id = $1::text and ($2::uuid is null or session_id is distinct from $2)'
        using p_user_id, p_keep_session_id;
    else
      execute 'delete from auth.refresh_tokens where user_id = $1::text' using p_user_id;
    end if;
  end if;
  return v_count;
end;
$$;

revoke all on function public.revoke_user_sessions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid, uuid) to service_role;
