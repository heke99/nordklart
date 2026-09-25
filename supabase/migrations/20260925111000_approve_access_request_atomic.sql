-- Approving a company access request wrote the membership and the request's
-- status in two separate statements from the route. A failure between them
-- left an active member with a request still 'pending' (approvable again), and
-- two concurrent approvals could both pass the 'pending' check. The upsert
-- also overwrote an existing member's role, so approving a stale request could
-- downgrade someone.
--
-- approve_company_access_request does it in one transaction: it locks the
-- request row, requires it to be pending and belong to the company, creates or
-- re-activates the membership without ever lowering an active member's role,
-- and marks the request approved. Service role only — the route has already
-- authorized the caller through canManageCompany.
--
-- pg-test: tests/pg/approve-access-request.pg.test.ts

create or replace function public.approve_company_access_request(
  p_request_id uuid,
  p_company_id uuid,
  p_role text,
  p_actor uuid
)
returns table (requester_user_id uuid, role text, membership_kind text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.company_access_requests%rowtype;
  v_kind text;
  v_existing public.company_members%rowtype;
  v_now timestamptz := now();
begin
  if p_role not in ('admin', 'member', 'viewer', 'accountant', 'auditor') then
    raise exception 'invalid role %', p_role using errcode = '22023';
  end if;

  select * into v_req
    from public.company_access_requests r
   where r.id = p_request_id and r.company_id = p_company_id
   for update;
  if not found then
    raise exception 'access request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'access request is not pending' using errcode = '55000';
  end if;

  v_kind := case when p_role in ('viewer', 'auditor', 'accountant') then 'external' else 'internal' end;

  select * into v_existing
    from public.company_members cm
   where cm.company_id = p_company_id and cm.user_id = v_req.requester_user_id
   for update;

  if found and v_existing.status = 'active' then
    -- Already a full member: never change their role from a request.
    p_role := v_existing.role;
    v_kind := coalesce(v_existing.membership_kind, v_kind);
  elsif found then
    update public.company_members cm
       set role = p_role, source = 'direct', status = 'active', access_source = 'access_request',
           membership_kind = v_kind, approved_by = p_actor, approved_at = v_now,
           revoked_by = null, revoked_at = null
     where cm.id = v_existing.id;
  else
    insert into public.company_members
      (company_id, user_id, role, source, status, access_source, membership_kind, approved_by, approved_at)
    values
      (p_company_id, v_req.requester_user_id, p_role, 'direct', 'active', 'access_request', v_kind, p_actor, v_now);
  end if;

  update public.company_access_requests r
     set status = 'approved', requested_role = p_role, reviewed_by = p_actor, reviewed_at = v_now
   where r.id = v_req.id;

  return query select v_req.requester_user_id, p_role, v_kind;
end;
$$;

revoke all on function public.approve_company_access_request(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.approve_company_access_request(uuid, uuid, text, uuid) to service_role;
