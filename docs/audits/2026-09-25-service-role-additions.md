# Service-role additions — 2026-09-25

Three route files were added to `scripts/checks/service-role-baseline.json`. Each was reviewed against the same four checks as the 2026-08-08 review: actor, company, resource, permission.

## `app/api/company/agency-links/route.ts` (GET)

- **Actor:** `withRouteContext` authenticates the user and enforces MFA (AAL2).
- **Company:** the `companyId` is the active company, validated through `resolve_company_access`.
- **Permission:** the caller must have `canManageCompany`. Agency access never grants that (migration `20260925110000`), so only the client's direct owner or admin, or a platform admin, passes.
- **Resource:** every `agency_clients` query is filtered by `company_id = companyId`. The agency names are read only for the `agency_id`s that come out of that filtered query.
- **Why service role:** `agencies` RLS only shows an agency to its own members, and the client needs to see the agency's name.

## `app/api/company/agency-links/[id]/route.ts` (PATCH)

- **Actor, company and permission:** same as the GET route above.
- **Resource:** a single conditional `UPDATE ... WHERE id = :id AND company_id = :companyId AND status IN (...)`, so the caller cannot touch another company's link. Approve only matches `pending`. Revoke matches `pending`, `active` or `paused`.
- **Why service role:** writing to `auth_audit_events`, which has no user write policy. The update itself is also allowed by the `agency_clients_update` RLS policy for a direct company admin.

## `app/api/platform/companies/[companyId]/founder-verification/route.ts` (POST)

- **Actor:** `requireAuth` authenticates the user and enforces MFA.
- **Permission:** the route checks for an active, non-revoked `platform_admin` row in `platform_roles`. The RPC `platform_decide_founder_verification` checks the same role again for `p_actor` in the same transaction.
- **Resource:** the RPC only updates the `owner` row for `(company_id, user_id)` whose `verification_status` is `manual_review`, and writes the audit event in the same transaction.
- **Why service role:** the RPC is granted to `service_role` only.

## `app/api/salary/runs/[id]/correct/route.ts` (POST)

- **Actor:** `withRouteContext` handles auth and MFA, and `requireWritePermission` checks write access.
- **Company and resource:** the run is loaded with the user's client and filtered by `company_id` and `status = 'booked'`.
- **Permission:** the service role is only used to call `correct_salary_run`, which is granted to `service_role` only, like `reverse_journal_entry_v2` which it calls. The RPC checks the actor's `can_write` again through `resolve_company_access_for_user`, and it locks the run and filters everything by `company_id`.

## `app/api/bookkeeping/fiscal-periods/[id]/dividend/route.ts` (GET, POST)

- **Actor:** `withRouteContext` handles auth and MFA.
- **Company and permission:** `requireYearEndAccess` resolves the actor's access to the company and to fiscal period `[id]` (the balance-sheet year). POST passes `requireWrite: true`, and the wrapper also has `requireWrite`.
- **Resource:** every read is filtered by `company_id` and the period id. The dividend proposal and decision come from those filtered reads, never from the request body.
- **Why service role:** `book_dividend_decision`, `book_dividend_payment`, `dividend_distributable_amount` and `__ledger_balance_at` are granted to `service_role` only. They repeat every ABL check under a row lock and filter by `p_company_id`. The drafts are created through the engine (`createDraftEntry`) with the same client.

## `app/api/bookkeeping/fiscal-periods/[id]/inventory/route.ts` (GET, POST)

- **Actor:** `withRouteContext` handles auth and MFA.
- **Company and permission:** `requireYearEndAccess` checks access to the company and the period, with write access required for POST.
- **Resource and why service role:** the service client is used only for `__ledger_balance_at`, which is service-role only, on the inventory accounts of `companyId`. The period read and the voucher (`createJournalEntry`) use the user's RLS client.
