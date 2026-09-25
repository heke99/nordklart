-- The access model has two external direct roles, 'accountant' and 'auditor':
-- resolve_company_access_for_user maps them (accountant writes, auditor
-- reviews), the invite and access-request routes offer them, and
-- lib/access/company.ts types them. The CHECK constraints on company_members,
-- company_invitations and company_access_requests still allowed only
-- owner/admin/member/viewer, so inviting or approving an accountant or auditor
-- failed with a constraint violation (HTTP 500). Widen the constraints to the
-- roles the rest of the system already implements.
--
-- pg-test: tests/pg/approve-access-request.pg.test.ts

alter table public.company_members drop constraint if exists company_members_role_check;
alter table public.company_members add constraint company_members_role_check
  check (role in ('owner', 'admin', 'member', 'viewer', 'accountant', 'auditor'));

alter table public.company_invitations drop constraint if exists company_invitations_role_check;
alter table public.company_invitations add constraint company_invitations_role_check
  check (role in ('owner', 'admin', 'member', 'viewer', 'accountant', 'auditor'));

alter table public.company_access_requests drop constraint if exists company_access_requests_requested_role_check;
alter table public.company_access_requests add constraint company_access_requests_requested_role_check
  check (requested_role in ('admin', 'member', 'viewer', 'accountant', 'auditor'));

notify pgrst, 'reload schema';
