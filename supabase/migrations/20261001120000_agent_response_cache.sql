-- Saved assistant answers, so the same question is not paid for twice.
--
-- When a conversation's first turn produces an answer without calling any
-- tool, the answer is stored under a key built from the company, the intent,
-- the model, the hash of the full system prompt (which already covers the
-- date, the company profile, memory and VAT status) and the normalized user
-- message. The same first turn later is answered from here instead of from
-- the model. Anything that changes the context changes the prompt hash, so a
-- stale answer is never served; rows also expire.
--
-- Written and read only by the server with the service role, after the
-- route has checked the caller's access to the company: company members
-- must not be able to plant answers that other members would receive.
--
-- pg-test: tests/pg/agent-response-cache.pg.test.ts

create table if not exists public.agent_response_cache (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  cache_key text not null,
  intent_id text not null,
  model text not null,
  prompt_hash text not null,
  response jsonb not null,
  response_text text not null,
  hit_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_hit_at timestamptz,
  expires_at timestamptz not null,
  constraint agent_response_cache_key_len check (char_length(cache_key) between 32 and 200),
  constraint agent_response_cache_text_len check (char_length(response_text) <= 60000)
);

create unique index if not exists agent_response_cache_company_key_idx
  on public.agent_response_cache (company_id, cache_key);
create index if not exists agent_response_cache_expires_idx
  on public.agent_response_cache (expires_at);

alter table public.agent_response_cache enable row level security;
revoke all on public.agent_response_cache from public, anon, authenticated;
grant select, insert, update, delete on public.agent_response_cache to service_role;

comment on table public.agent_response_cache is
  'Assistant answers reused for an identical first turn (same company, intent, model, system prompt and question). Service role only.';

-- Records a cache hit and returns the stored answer in one round trip.
create or replace function public.agent_response_cache_hit(p_company_id uuid, p_cache_key text)
returns table (response jsonb, response_text text)
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  update public.agent_response_cache c
     set hit_count = c.hit_count + 1,
         last_hit_at = now()
   where c.company_id = p_company_id
     and c.cache_key = p_cache_key
     and c.expires_at > now()
  returning c.response, c.response_text;
$$;

revoke all on function public.agent_response_cache_hit(uuid, text) from public, anon, authenticated;
grant execute on function public.agent_response_cache_hit(uuid, text) to service_role;

NOTIFY pgrst, 'reload schema';
