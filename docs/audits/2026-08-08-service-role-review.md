# Service-role authorization review — 2026-08-08

A service-role Supabase client bypasses RLS completely. Every place one is
constructed is therefore a place where tenant isolation rests on hand-written
checks rather than on the database. This review walks the whole surface and asks
one question per call site:

> Before the privileged operation runs, has the code established
> **actor → company → resource → permission**?

Scope: `app/`, `lib/`, `extensions/`, excluding tests.
**108 files construct a service-role client.** All 108 were classified.

## Result

**One new finding (#21), fixed.** Everything else resolves into five patterns,
each of which carries its authorization somewhere provable.

| Pattern | Files | Where authorization lives |
|---|---:|---|
| Authenticated API route | 52 | `withRouteContext` → `requireAuth()` → `getActiveCompanyId` / `resolve_company_access_for_user`, plus `requireWrite` |
| Cron | 7 | `withCronContext` → `verifyCronSecret()`, constant-time |
| Machine-to-machine webhook | 3 | shared secret / Stripe signature, verified constant-time before any read |
| Platform surface | 14 | `requirePlatformRole()` in the page/route **and** `require_platform_commercial_admin()` inside each `platform_*` RPC |
| Library helper, company-bound | 32 | takes an already-authorized `companyId` and filters every query by it |

### Finding #21 — a revoked platform role still authorized

`platform_roles` records revocation (`revoked_at`) rather than deleting the
grant. Two authorization queries matched only on `user_id` + `role` and so kept
returning the row after revocation:

- `GET /api/platform/companies/[companyId]/troubleshooting` — a revoked operator
  could still export a company's operational report: org number, bank-connection
  and Skatteverket state, failed operations, recent event types.
- `GET /api/health/deep` — a revoked operator kept the deep health view.

Both now filter `.is('revoked_at', null)`, matching `requirePlatformRole()`,
`lib/billing/access.ts`, `lib/year-end/access.ts`, `lib/workspace/actions.ts`
and the dashboard layout, which all had it. The SQL side was checked too:
`is_platform_admin()`, `resolve_company_access_for_user` and
`platform_revoke_platform_role` all filter revocation correctly.

Regression coverage:
`app/api/platform/companies/[companyId]/troubleshooting/__tests__/route.test.ts`
models `platform_roles` as rows carrying `revoked_at` and drops revoked rows only
when the query asks — so the test fails against the pre-fix route (verified) and
would fail again if the predicate were removed.
`scripts/checks/platform-role-revocation.mjs` makes it permanent: any
`platform_roles` query without a revocation predicate fails the build unless it
explicitly selects `revoked_at` as data (the admin listing screen).

Finding #20 — `resolveSieImportAccess` deriving write capability from
`effective_role` instead of from the canonical resolver — was found and fixed
earlier on this branch and is the reason this pass exists.

### The checks that actually carry the weight

**`withRouteContext` (`lib/api/with-route-context.ts`).** The `companyId` handed
to a handler is never taken from the request unless `allowRequestedCompany` is
set, and in that case `?company_id=` is resolved through
`resolve_company_access_for_user` under the service role and rejected unless
`can_read`. Write capability comes from the same row (`can_write`), never
re-derived from a role name. The one `||` in that path —
`can_write || can_manage_platform` — is sound: `can_manage_platform` is defined
as `effective_role = 'platform_admin'` and nothing else.

**`resolve_company_access_for_user`.** Single source of truth for the shape
`can_write = role IN (…) AND membership_status = 'active'`. Note the asymmetry
that produced finding #20: `company_member_is_active()` admits both `'active'`
and `'active_limited'`, so a limited member passes `can_read` but not
`can_write`. Any code that re-derives write access from the role list alone
silently promotes limited members. That is now a single expression in one place.

**Entitlement ≠ authorization.** Checked explicitly, because merging the two is
exactly what #20 was. `lib/year-end/access.ts` gets this right by construction:
an entitlement can only substitute when the canonical resolver's reason is
`missing_entitlement`, never for company access, period binding, write
capability or a resolver error — those keep failing closed.

**Platform server actions.** Server actions are directly invocable POST
endpoints, so a layout guard does not protect them. All five actions in
`app/(dashboard)/platform/companies/[companyId]/actions.ts` call
`requirePlatformAdmin()` themselves (four via `assertCompany`), and the
underlying `platform_*` RPCs re-check with `require_platform_commercial_admin()`
and are `REVOKE … FROM public`. Two independent layers.

**Webhooks that name their own tenant.** `/api/peppol/inbound` takes
`company_id` in the body. That is correct for this trust model — the shared
secret authenticates the *access point*, not the tenant — and the route
explicitly verifies the company exists rather than trusting the id blindly.

## Permanent guard

Review findings decay. `scripts/checks/service-role-surface.mjs` (wired into
`npm run check:guards`, which CI runs) freezes the surface at these 108 files:
a new file constructing a service-role client fails the build until it has been
reviewed and added to `scripts/checks/service-role-baseline.json`. Removals are
always allowed and are reported as prunable.

The guard deliberately does not try to prove the checks *inside* a file are
correct — that is what this review and
`tests/pg/tenant-isolation-matrix.pg.test.ts` are for. It only makes growth of
the surface a decision instead of an accident.
