-- OpenDataLoader OCR foundation + founder access bootstrap.
-- The OCR table keeps raw OCR/layout output separate from interpreted
-- accounting fields in document_attachments.extracted_data.

create table if not exists public.document_ocr_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  document_id uuid not null references public.document_attachments(id) on delete cascade,

  provider text not null default 'opendataloader_pdf',
  mode text not null default 'pdf_or_ocr',
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'skipped')),

  input_mime_type text,
  input_file_size_bytes bigint,
  input_sha256_hash text,

  output_text text,
  output_markdown text,
  output_json jsonb,
  page_count integer,
  language_hint text not null default 'sv,en',

  error_code text,
  error_message text,

  queued_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint document_ocr_runs_status_timestamps check (
    (status in ('queued', 'skipped') and started_at is null)
    or (status in ('running', 'succeeded', 'failed') and started_at is not null)
  ),
  constraint document_ocr_runs_completed_status check (
    (status in ('succeeded', 'failed', 'skipped') and completed_at is not null)
    or (status in ('queued', 'running') and completed_at is null)
  ),
  constraint document_ocr_runs_unique unique (document_id, provider, mode)
);

create index if not exists document_ocr_runs_company_status_idx
  on public.document_ocr_runs(company_id, status, queued_at desc);

create index if not exists document_ocr_runs_document_idx
  on public.document_ocr_runs(document_id, created_at desc);

drop trigger if exists document_ocr_runs_updated_at on public.document_ocr_runs;
create trigger document_ocr_runs_updated_at
  before update on public.document_ocr_runs
  for each row execute function public.update_updated_at_column();

alter table public.document_ocr_runs enable row level security;

drop policy if exists document_ocr_runs_select on public.document_ocr_runs;
create policy document_ocr_runs_select on public.document_ocr_runs
  for select using (
    public.is_platform_admin()
    or exists (
      select 1 from public.company_members cm
      where cm.company_id = document_ocr_runs.company_id
        and cm.user_id = auth.uid()
    )
  );

drop policy if exists document_ocr_runs_service_write on public.document_ocr_runs;
create policy document_ocr_runs_service_write on public.document_ocr_runs
  for all using (public.is_platform_admin()) with check (public.is_platform_admin());

grant select on public.document_ocr_runs to authenticated;
grant all on public.document_ocr_runs to service_role;

-- Founder bootstrap requested by owner. Idempotent and safe if the auth user
-- does not exist yet: the insert simply affects zero rows.
with founder as (
  select id from auth.users where id = '9dcbf493-6f9c-41ae-83d0-3eac010e32d0'::uuid
)
insert into public.platform_roles (user_id, role, granted_by, granted_at, revoked_at, note)
select id, 'platform_admin', null, now(), null, 'Founder superadmin bootstrap'
from founder
on conflict (user_id) do update set
  role = 'platform_admin',
  granted_by = null,
  granted_at = now(),
  revoked_at = null,
  note = 'Founder superadmin bootstrap';

-- Give the founder's existing companies full product access and Bankgiro
-- access. Platform admin access remains global; these grants make the user's
-- own workspaces pass commercial feature gates without manual UI setup.
with founder_companies as (
  select distinct c.id as company_id
  from public.companies c
  left join public.company_members cm on cm.company_id = c.id
  where c.archived_at is null
    and (
      c.created_by = '9dcbf493-6f9c-41ae-83d0-3eac010e32d0'::uuid
      or cm.user_id = '9dcbf493-6f9c-41ae-83d0-3eac010e32d0'::uuid
    )
), inserted_full as (
  insert into public.commercial_access_grants (
    company_id, grant_type, status, starts_at, expires_at, note, granted_by, metadata
  )
  select
    fc.company_id,
    'complimentary_full_access',
    'active',
    now(),
    null,
    'Founder full product access bootstrap',
    '9dcbf493-6f9c-41ae-83d0-3eac010e32d0'::uuid,
    jsonb_build_object('label', 'Complimentary Full Access', 'source', 'founder_bootstrap')
  from founder_companies fc
  where not exists (
    select 1 from public.commercial_access_grants g
    where g.company_id = fc.company_id
      and g.grant_type = 'complimentary_full_access'
      and g.status in ('active', 'scheduled')
      and (g.expires_at is null or g.expires_at > now())
  )
  returning id, company_id
), active_full as (
  select id, company_id from inserted_full
  union all
  select g.id, g.company_id
  from public.commercial_access_grants g
  join founder_companies fc on fc.company_id = g.company_id
  where g.grant_type = 'complimentary_full_access'
    and g.status in ('active', 'scheduled')
    and (g.expires_at is null or g.expires_at > now())
)
insert into public.commercial_access_grant_features (grant_id, feature_id, enabled)
select af.id, pf.id, true
from active_full af
cross join public.platform_features pf
where pf.code not like 'bankgiro.%'
  and pf.code <> 'bankgiro.provider_module'
on conflict (grant_id, feature_id) do update set enabled = true, updated_at = now();

with founder_companies as (
  select distinct c.id as company_id
  from public.companies c
  left join public.company_members cm on cm.company_id = c.id
  where c.archived_at is null
    and (
      c.created_by = '9dcbf493-6f9c-41ae-83d0-3eac010e32d0'::uuid
      or cm.user_id = '9dcbf493-6f9c-41ae-83d0-3eac010e32d0'::uuid
    )
), inserted_bankgiro as (
  insert into public.commercial_access_grants (
    company_id, grant_type, status, starts_at, expires_at, note, granted_by, metadata
  )
  select
    fc.company_id,
    'complimentary_bankgiro',
    'active',
    now(),
    null,
    'Founder Bankgiro access bootstrap',
    '9dcbf493-6f9c-41ae-83d0-3eac010e32d0'::uuid,
    jsonb_build_object('label', 'Complimentary Bankgiro', 'source', 'founder_bootstrap')
  from founder_companies fc
  where not exists (
    select 1 from public.commercial_access_grants g
    where g.company_id = fc.company_id
      and g.grant_type = 'complimentary_bankgiro'
      and g.status in ('active', 'scheduled')
      and (g.expires_at is null or g.expires_at > now())
  )
  returning id, company_id
), active_bankgiro as (
  select id, company_id from inserted_bankgiro
  union all
  select g.id, g.company_id
  from public.commercial_access_grants g
  join founder_companies fc on fc.company_id = g.company_id
  where g.grant_type = 'complimentary_bankgiro'
    and g.status in ('active', 'scheduled')
    and (g.expires_at is null or g.expires_at > now())
)
insert into public.commercial_access_grant_features (grant_id, feature_id, enabled)
select ab.id, pf.id, true
from active_bankgiro ab
cross join public.platform_features pf
where pf.code like 'bankgiro.%'
   or pf.code = 'bankgiro.provider_module'
on conflict (grant_id, feature_id) do update set enabled = true, updated_at = now();
