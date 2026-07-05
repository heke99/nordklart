-- Agency client consent hardening.
--
-- The previous agency_clients_write policy allowed any agency admin to
-- INSERT or UPDATE rows checked only on user_is_agency_admin(agency_id).
-- Because user_can_access_company_v2() grants company access through
-- active agency_clients + active agency_members, an agency admin could
-- link an arbitrary company_id with status = 'active' and grant their
-- whole agency read/write access to a foreign tenant — no consent from
-- the client company required.
--
-- New model:
--   * INSERT: agency admins may create rows, but 'active' status requires
--     the actor to also be an owner/admin of the client company (the
--     self-service case where the agency created the client's workspace).
--     Everything else starts as 'pending'.
--   * UPDATE: the client company's owner/admin approves (activates) a
--     pending link; agency admins can manage rows but cannot set
--     status = 'active' unless they administer the client company.
--   * DELETE: agency admins can remove their own links; client company
--     admins can sever the relationship from their side.
--   * Platform admins retain full control (user_is_agency_admin already
--     includes is_platform_admin, kept explicit for readability).
--
-- Security-definer provisioning RPCs (signup, backfills) run as the table
-- owner and are unaffected.

drop policy if exists agency_clients_write on public.agency_clients;

drop policy if exists agency_clients_insert on public.agency_clients;
create policy agency_clients_insert on public.agency_clients
  for insert with check (
    public.is_platform_admin()
    or (
      public.user_is_agency_admin(agency_id)
      and (status <> 'active' or public.user_is_company_admin(company_id))
    )
  );

drop policy if exists agency_clients_update on public.agency_clients;
create policy agency_clients_update on public.agency_clients
  for update using (
    public.is_platform_admin()
    or public.user_is_agency_admin(agency_id)
    or public.user_is_company_admin(company_id)
  )
  with check (
    public.is_platform_admin()
    or public.user_is_company_admin(company_id)
    or (public.user_is_agency_admin(agency_id) and status <> 'active')
  );

drop policy if exists agency_clients_delete on public.agency_clients;
create policy agency_clients_delete on public.agency_clients
  for delete using (
    public.is_platform_admin()
    or public.user_is_agency_admin(agency_id)
    or public.user_is_company_admin(company_id)
  );

notify pgrst, 'reload schema';
