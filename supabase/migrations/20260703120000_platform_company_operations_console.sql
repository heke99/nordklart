-- Nordklart platform company operations console + accounting integrity views.
-- Non-destructive: adds read models for superadmin operations and accounting
-- integrity checks without changing posted accounting rows.
--
-- Replace the full migration file with this version:
-- supabase/migrations/20260703120000_platform_company_operations_console.sql

-- -----------------------------------------------------------------------------
-- 0. Compatibility guards for live schema drift
-- -----------------------------------------------------------------------------

-- Bankgiro application columns used by platform operational views.
alter table if exists public.bankgiro_applications
  add column if not exists beneficial_owners jsonb not null default '[]'::jsonb,
  add column if not exists company_questions jsonb not null default '{}'::jsonb,
  add column if not exists volume_answers jsonb not null default '{}'::jsonb,
  add column if not exists documents_status text not null default 'not_started',
  add column if not exists provider_setup_status text not null default 'not_started',
  add column if not exists risk_score integer,
  add column if not exists superadmin_note text;

-- Supplier invoice document linkage used by the accounting integrity views.
alter table if exists public.supplier_invoices
  add column if not exists document_id uuid;

create index if not exists supplier_invoices_document_id_idx
  on public.supplier_invoices(document_id)
  where document_id is not null;

-- Invoice inbox compatibility. Do not reference non-existing columns such as
-- document_type in views; only guard columns that the read model needs.
alter table if exists public.invoice_inbox_items
  add column if not exists email_subject text,
  add column if not exists document_id uuid,
  add column if not exists created_supplier_invoice_id uuid,
  add column if not exists created_journal_entry_id uuid,
  add column if not exists error_message text;

create index if not exists invoice_inbox_items_document_id_idx
  on public.invoice_inbox_items(document_id)
  where document_id is not null;

create index if not exists invoice_inbox_items_created_supplier_invoice_id_idx
  on public.invoice_inbox_items(created_supplier_invoice_id)
  where created_supplier_invoice_id is not null;

create index if not exists invoice_inbox_items_created_journal_entry_id_idx
  on public.invoice_inbox_items(created_journal_entry_id)
  where created_journal_entry_id is not null;

-- Company member compatibility for the platform user overview.
alter table if exists public.company_members
  add column if not exists membership_kind text not null default 'internal',
  add column if not exists access_source text not null default 'direct',
  add column if not exists verification_status text,
  add column if not exists joined_at timestamptz,
  add column if not exists revoked_at timestamptz;

-- One-time purchase compatibility for year-end access checks.
alter table if exists public.one_time_purchases
  add column if not exists access_expires_at timestamptz;

-- Drop views first so repeated runs do not fail on changed view definitions.
drop view if exists public.platform_company_accounting_integrity_v cascade;
drop view if exists public.bookkeeping_integrity_issues_v cascade;
drop view if exists public.bookkeeping_source_status_v cascade;
drop view if exists public.platform_company_overview_v cascade;
drop view if exists public.platform_company_user_overview_v cascade;
drop view if exists public.platform_company_operational_status_v cascade;
drop view if exists public.platform_company_commercial_status_v cascade;

-- -----------------------------------------------------------------------------
-- 1. Commercial status per company
-- -----------------------------------------------------------------------------
create or replace view public.platform_company_commercial_status_v
with (security_invoker = true)
as
select
  c.id as company_id,
  active_subscription.id as subscription_id,
  active_subscription.status as subscription_status,
  active_subscription.starts_at as subscription_starts_at,
  active_subscription.current_period_end,
  active_subscription.trial_ends_at,
  active_subscription.plan_version_id,
  active_subscription.plan_id,
  active_subscription.plan_code,
  active_subscription.plan_name,
  active_subscription.price_excl_vat,
  active_subscription.currency,
  active_subscription.billing_interval,
  active_subscription.external_provider,
  active_subscription.external_subscription_id,
  active_subscription.override_note,
  coalesce(active_grants.active_grant_count, 0)::integer as active_grant_count,
  coalesce(active_grants.active_grant_types, '{}'::text[]) as active_grant_types,
  coalesce(one_time.active_one_time_count, 0)::integer as active_one_time_count,
  coalesce(one_time.active_purchase_types, '{}'::text[]) as active_purchase_types,
  case
    when active_subscription.id is not null then 'subscription'
    when coalesce(active_grants.active_grant_count, 0) > 0 then 'grant'
    when coalesce(one_time.active_one_time_count, 0) > 0 then 'one_time'
    else 'missing'
  end as access_source,
  case
    when active_subscription.status in ('trialing', 'active') then 'active'
    when coalesce(active_grants.active_grant_count, 0) > 0 then 'active'
    when coalesce(one_time.active_one_time_count, 0) > 0 then 'active'
    when active_subscription.status is not null then active_subscription.status
    else 'missing'
  end as access_status
from public.companies c
left join lateral (
  select
    cs.id,
    cs.status,
    cs.starts_at,
    cs.current_period_end,
    cs.trial_ends_at,
    cs.plan_version_id,
    coalesce(pv.plan_id, cs.plan_id) as plan_id,
    pp.code as plan_code,
    coalesce(pp.public_name, pp.name) as plan_name,
    coalesce(pv.price_excl_vat, pp.price_excl_vat) as price_excl_vat,
    coalesce(pv.currency, pp.currency) as currency,
    coalesce(pv.billing_interval, pp.billing_interval) as billing_interval,
    cs.external_provider,
    cs.external_subscription_id,
    cs.override_note
  from public.company_subscriptions cs
  left join public.platform_plan_versions pv on pv.id = cs.plan_version_id
  left join public.platform_price_plans pp on pp.id = coalesce(pv.plan_id, cs.plan_id)
  where cs.company_id = c.id
  order by
    case cs.status
      when 'active' then 1
      when 'trialing' then 2
      when 'past_due' then 3
      when 'paused' then 4
      else 9
    end,
    cs.created_at desc
  limit 1
) active_subscription on true
left join lateral (
  select
    count(*) as active_grant_count,
    array_agg(distinct cag.grant_type order by cag.grant_type) as active_grant_types
  from public.commercial_access_grants cag
  where cag.company_id = c.id
    and cag.status in ('active', 'scheduled')
    and cag.starts_at <= now()
    and (cag.expires_at is null or cag.expires_at > now())
) active_grants on true
left join lateral (
  select
    count(*) as active_one_time_count,
    array_agg(distinct op.purchase_type order by op.purchase_type) as active_purchase_types
  from public.one_time_purchases op
  where op.company_id = c.id
    and op.status in ('paid', 'active', 'fulfilled')
    and (op.access_expires_at is null or op.access_expires_at > now())
) one_time on true;

grant select on public.platform_company_commercial_status_v to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Operational status per company
-- -----------------------------------------------------------------------------
create or replace view public.platform_company_operational_status_v
with (security_invoker = true)
as
select
  c.id as company_id,
  onboarding.status as onboarding_status,
  onboarding.updated_at as onboarding_updated_at,
  bankgiro.status as bankgiro_status,
  bankgiro.provider_setup_status as bankgiro_provider_setup_status,
  bankgiro.documents_status as bankgiro_documents_status,
  bankgiro.updated_at as bankgiro_updated_at,
  coalesce(year_end.active_year_end_access_count, 0)::integer as active_year_end_access_count,
  coalesce(review_queue.open_review_count, 0)::integer as open_review_count,
  coalesce(journal_stats.journal_entry_count, 0)::integer as journal_entry_count,
  journal_stats.last_journal_entry_at,
  coalesce(document_stats.unlinked_document_count, 0)::integer as unlinked_document_count,
  coalesce(inbox_stats.pending_inbox_count, 0)::integer as pending_inbox_count,
  coalesce(transaction_stats.unbooked_transaction_count, 0)::integer as unbooked_transaction_count
from public.companies c
left join lateral (
  select os.status, os.updated_at
  from public.onboarding_sessions os
  where os.company_id = c.id
  order by os.updated_at desc nulls last, os.created_at desc
  limit 1
) onboarding on true
left join lateral (
  select ba.status, ba.provider_setup_status, ba.documents_status, ba.updated_at
  from public.bankgiro_applications ba
  where ba.company_id = c.id
  order by ba.updated_at desc, ba.created_at desc
  limit 1
) bankgiro on true
left join lateral (
  select count(*) as active_year_end_access_count
  from public.one_time_purchases otp
  where otp.company_id = c.id
    and otp.status in ('paid', 'active', 'fulfilled')
    and (
      otp.purchase_type ilike '%year_end%'
      or otp.purchase_type ilike '%bokslut%'
      or otp.purchase_type ilike '%tax%'
      or otp.purchase_type ilike '%declaration%'
      or otp.purchase_type ilike '%ink2%'
    )
    and (otp.access_expires_at is null or otp.access_expires_at > now())
) year_end on true
left join lateral (
  select count(*) as open_review_count
  from public.review_queue_items rqi
  where rqi.company_id = c.id
    and rqi.status in ('open', 'in_review')
) review_queue on true
left join lateral (
  select count(*) as journal_entry_count, max(je.created_at) as last_journal_entry_at
  from public.journal_entries je
  where je.company_id = c.id
) journal_stats on true
left join lateral (
  select count(*) as unlinked_document_count
  from public.document_attachments da
  where da.company_id = c.id
    and da.is_current_version = true
    and da.journal_entry_id is null
) document_stats on true
left join lateral (
  select count(*) as pending_inbox_count
  from public.invoice_inbox_items iii
  where iii.company_id = c.id
    and iii.status in ('pending', 'processing', 'ready', 'error')
) inbox_stats on true
left join lateral (
  select count(*) as unbooked_transaction_count
  from public.transactions t
  where t.company_id = c.id
    and t.journal_entry_id is null
    and coalesce(t.is_ignored, false) = false
) transaction_stats on true;

grant select on public.platform_company_operational_status_v to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Company overview and users
-- -----------------------------------------------------------------------------
create or replace view public.platform_company_overview_v
with (security_invoker = true)
as
select
  c.id,
  c.name,
  c.org_number,
  c.entity_type,
  c.created_by,
  c.archived_at,
  c.created_at,
  c.updated_at,
  case
    when owned_agency.agency_id is not null then 'agency'
    when client_agency.client_agency_id is not null then 'agency_client'
    else 'company'
  end as workspace_kind,
  owned_agency.agency_id,
  owned_agency.agency_name,
  client_agency.client_agency_id,
  client_agency.client_agency_name,
  coalesce(members.member_count, 0)::integer as member_count,
  coalesce(members.active_member_count, 0)::integer as active_member_count,
  comm.access_source,
  comm.access_status,
  comm.plan_name,
  comm.plan_code,
  comm.subscription_status,
  comm.current_period_end,
  comm.active_grant_count,
  comm.active_grant_types,
  ops.onboarding_status,
  ops.bankgiro_status,
  ops.active_year_end_access_count,
  ops.open_review_count,
  ops.journal_entry_count,
  ops.last_journal_entry_at,
  ops.unlinked_document_count,
  ops.pending_inbox_count,
  ops.unbooked_transaction_count
from public.companies c
left join lateral (
  select a.id as agency_id, a.name as agency_name
  from public.agencies a
  where a.company_id = c.id
  limit 1
) owned_agency on true
left join lateral (
  select a.id as client_agency_id, a.name as client_agency_name
  from public.agency_clients ac
  join public.agencies a on a.id = ac.agency_id
  where ac.company_id = c.id
    and ac.status in ('pending', 'active', 'paused', 'suspended')
  order by
    case ac.status
      when 'active' then 1
      when 'pending' then 2
      else 3
    end,
    ac.created_at desc
  limit 1
) client_agency on true
left join lateral (
  select
    count(*) as member_count,
    count(*) filter (where coalesce(cm.status, 'active') in ('active', 'active_limited')) as active_member_count
  from public.company_members cm
  where cm.company_id = c.id
) members on true
left join public.platform_company_commercial_status_v comm on comm.company_id = c.id
left join public.platform_company_operational_status_v ops on ops.company_id = c.id;

grant select on public.platform_company_overview_v to authenticated, service_role;

create or replace view public.platform_company_user_overview_v
with (security_invoker = true)
as
select
  cm.company_id,
  cm.id as membership_id,
  cm.user_id,
  p.email,
  p.full_name,
  cm.role,
  coalesce(cm.status, 'active') as status,
  coalesce(cm.membership_kind, 'internal') as membership_kind,
  coalesce(cm.access_source, 'direct') as access_source,
  cm.verification_status,
  cm.joined_at,
  cm.created_at,
  cm.updated_at,
  cm.revoked_at
from public.company_members cm
left join public.profiles p on p.id = cm.user_id;

grant select on public.platform_company_user_overview_v to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Accounting integrity read model
-- -----------------------------------------------------------------------------
create or replace view public.bookkeeping_source_status_v
with (security_invoker = true)
as
select
  si.company_id,
  'supplier_invoice'::text as source_type,
  si.id as source_id,
  si.supplier_invoice_number as source_label,
  si.status as source_status,
  case
    when coalesce(si.paid_with_private_funds, false) and si.payment_journal_entry_id is null then 'requires_repair'
    when coalesce(si.paid_with_private_funds, false) and si.document_id is not null and da.journal_entry_id is null then 'requires_repair'
    when si.registration_journal_entry_id is null
      and coalesce(cs.accounting_method, 'accrual') = 'accrual'
      and not coalesce(si.paid_with_private_funds, false)
      and not coalesce(si.is_credit_note, false)
      then 'requires_repair'
    when si.status in ('paid', 'partially_paid')
      and si.payment_journal_entry_id is null
      and not coalesce(si.paid_with_private_funds, false)
      then 'requires_repair'
    when si.document_id is not null and da.journal_entry_id is not null then 'linked'
    when si.registration_journal_entry_id is not null or si.payment_journal_entry_id is not null then 'booked'
    else 'ready_to_book'
  end as lifecycle_status,
  case
    when coalesce(si.paid_with_private_funds, false) and si.payment_journal_entry_id is null then 'Privat betalt utlägg saknar verifikation.'
    when coalesce(si.paid_with_private_funds, false) and si.document_id is not null and da.journal_entry_id is null then 'Utläggets underlag är inte länkat till verifikationen.'
    when si.registration_journal_entry_id is null
      and coalesce(cs.accounting_method, 'accrual') = 'accrual'
      and not coalesce(si.paid_with_private_funds, false)
      and not coalesce(si.is_credit_note, false)
      then 'Leverantörsfaktura saknar registreringsverifikation.'
    when si.status in ('paid', 'partially_paid')
      and si.payment_journal_entry_id is null
      and not coalesce(si.paid_with_private_funds, false)
      then 'Betald leverantörsfaktura saknar betalningsverifikation.'
    when si.document_id is null then 'Underlag saknas på leverantörsfakturan.'
    else null
  end as issue_message,
  coalesce(si.payment_journal_entry_id, si.registration_journal_entry_id) as journal_entry_id,
  si.document_id,
  si.created_at,
  si.updated_at
from public.supplier_invoices si
left join public.company_settings cs on cs.company_id = si.company_id
left join public.document_attachments da on da.id = si.document_id and da.company_id = si.company_id

union all

select
  iii.company_id,
  'invoice_inbox_item'::text as source_type,
  iii.id as source_id,
  coalesce(iii.email_subject, 'Inkorgsunderlag') as source_label,
  iii.status as source_status,
  case
    when iii.status in ('pending', 'processing') then 'uploaded'
    when iii.status = 'ready' then 'needs_review'
    when iii.status = 'confirmed' and iii.created_supplier_invoice_id is not null then 'booked'
    when iii.status = 'confirmed' and iii.created_journal_entry_id is not null then 'booked'
    when iii.status = 'error' then 'requires_repair'
    else 'needs_review'
  end as lifecycle_status,
  case
    when iii.status = 'ready' then 'Underlag är tolkat men inte bokfört.'
    when iii.status = 'error' then coalesce(iii.error_message, 'Inkorgsunderlag har felstatus.')
    when iii.status = 'confirmed'
      and iii.created_supplier_invoice_id is null
      and iii.created_journal_entry_id is null
      then 'Bekräftat underlag saknar bokföringskoppling.'
    else null
  end as issue_message,
  iii.created_journal_entry_id as journal_entry_id,
  iii.document_id,
  iii.created_at,
  iii.updated_at
from public.invoice_inbox_items iii

union all

select
  da.company_id,
  'document'::text as source_type,
  da.id as source_id,
  da.file_name as source_label,
  case when da.journal_entry_id is null then 'unlinked' else 'linked' end as source_status,
  case when da.journal_entry_id is null then 'needs_review' else 'linked' end as lifecycle_status,
  case when da.journal_entry_id is null then 'Underlag är inte länkat till en verifikation.' else null end as issue_message,
  da.journal_entry_id,
  da.id as document_id,
  da.created_at,
  da.updated_at
from public.document_attachments da
where da.is_current_version = true;

grant select on public.bookkeeping_source_status_v to authenticated, service_role;

create or replace view public.bookkeeping_integrity_issues_v
with (security_invoker = true)
as
select *
from public.bookkeeping_source_status_v
where lifecycle_status in ('requires_repair', 'needs_review')
  and issue_message is not null;

grant select on public.bookkeeping_integrity_issues_v to authenticated, service_role;

create or replace view public.platform_company_accounting_integrity_v
with (security_invoker = true)
as
select
  c.id as company_id,
  count(i.*)::integer as issue_count,
  count(i.*) filter (where i.lifecycle_status = 'requires_repair')::integer as repair_issue_count,
  count(i.*) filter (where i.lifecycle_status = 'needs_review')::integer as review_issue_count,
  min(i.created_at) as oldest_issue_at,
  max(i.updated_at) as latest_issue_at
from public.companies c
left join public.bookkeeping_integrity_issues_v i on i.company_id = c.id
  and i.created_at >= now() - interval '365 days'
group by c.id;

grant select on public.platform_company_accounting_integrity_v to authenticated, service_role;

notify pgrst, 'reload schema';
