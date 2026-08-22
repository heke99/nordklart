# Service-role review — three additions, 2026-08-21

`scripts/checks/service-role-surface.mjs` froze the set of files that may construct a
service-role Supabase client. Three files were added in this pass. The guard's bar is:
*verify actor → company → resource → permission before the privileged operation, and
filter every query by `company_id`.* Each addition is reviewed against that bar below.

The shared property that makes all three safe is narrower than the bar requires: none of
them touches a table with the service client at all. Each uses it for exactly one RPC,
and each RPC re-derives the actor's rights from scratch.

## `lib/bookkeeping/engine.ts` — `reverseEntry`
## `lib/core/bookkeeping/storno-service.ts` — `correctEntry`

Both call **only** `reverse_journal_entry_v2` (20260821120000). Inside that function:

- `require_service_role()` — the connection must be trusted at all.
- `resolve_company_access_for_user(p_actor_user_id, p_company_id)` must return
  `can_write` — the *named actor*, not the connection, must be able to write this
  company. A service-role connection alone authorises nothing.
- The original entry is selected `WHERE id = ... AND company_id = ...` `FOR UPDATE`, so a
  caller cannot reach across a tenant boundary with a guessed entry id.
- Both vouchers are materialised through `create_planned_draft_entry`, which re-checks
  the fiscal period lock and rejects any account outside that company's chart, and are
  posted through `commit_journal_entry`, which carries its own anon guard and write
  check.

Reads in the surrounding TypeScript still use the caller's RLS-scoped client. The service
client's entire surface is the one `rpc(...)` call.

Why a service client is needed at all: the RPC is `REVOKE ALL … FROM authenticated`,
deliberately, so the storno path cannot be driven directly from PostgREST with a user's
own JWT. Reaching it requires the service role, and the actor check inside the function
is what keeps that from being an escalation.

## `lib/auth/consent-service.ts` — `createConsentForSession`

Calls **only** `record_bankid_consent_v1` (20260821140000). Inside:

- `require_service_role()`.
- The BankID session is selected `WHERE id = ... AND user_id = p_actor_user_id`
  `FOR UPDATE`. Company scope is then taken from that session row, never from an argument
  — so a caller cannot pass someone else's `company_id`.
- The årsredovisning signature request, when present, is matched
  `WHERE id = ... AND company_id = <the session's company>`, and a request already signed
  by a *different* session is rejected rather than overwritten.

Authorisation here rests on the session, which is the correct anchor: the provider
confirmed the completion against that session's order reference, and the session was
created for that user.

## Why these are RPCs rather than ordinary writes

All three replace multi-statement write sequences that used the caller's own client and
compensated on failure. Compensation is best effort: a process that dies mid-sequence
leaves a posted voucher with no payment, or a recorded consent with an unsigned
signature request. Moving the sequence into one transaction is what removes that state,
and a transaction spanning several tables with locks is not something PostgREST can
express — hence a function, and hence the service role to reach it.

## `lib/auth/rate-limit-durable.ts` — `checkDurableRateLimit`

Calls **only** `consume_rate_limit` (20260821160000), and that function reads and writes
exactly one table: `public.rate_limit_counters`.

That table is deliberately outside the tenant model. It has no `company_id`, no
`user_id`, and holds no personal data — the identifier the BankID caller passes is
already truncated to a /24 or /48 by `truncateIp()` before it arrives. There is
therefore no tenant boundary for this call site to cross, and "filter every query by
`company_id`" has no referent here.

The reason it needs the service role is the inverse of the usual one. The endpoint it
guards (`POST /bankid/start`) is unauthenticated: there is no user, no company, and no
JWT to act under. Any role that could reach the counter could also read or forge other
callers' counters, so the table carries RLS with zero policies *and* no grants, and
`consume_rate_limit` is `REVOKE ALL … FROM PUBLIC, anon, authenticated`. Service role is
the only way in, and the function's whole surface is one counter increment that returns
a boolean.

Escalation surface: the function takes a bucket, an identifier and two integers, writes
one row keyed by (bucket, identifier), and returns `{allowed, limit, remaining,
reset_at}`. It cannot read, write or reveal anything else, and a caller who controls all
four arguments can at most rate-limit themselves differently.

## `lib/skatteverket/ombud.ts` — `recordSkvOmbudObservation`

Two privileged operations, both scoped to one company id the caller already
established:

1. `SELECT org_number FROM companies WHERE id = <companyId>` — a single row,
   filtered by the company id, returning one non-sensitive field. The company id
   is not attacker-supplied at this call site: it comes from an
   `ExtensionContext` / `SkvSysorgRequestOptions` whose company was already
   resolved and access-checked by `withRouteContext` (or, for the extension
   routes, by `requireAgiWriteRole`) before any Skatteverket call was made.
2. `record_skv_ombud_observation(company_id, org_number, auth_flow, observation)`
   — `REVOKE ALL … FROM PUBLIC, anon, authenticated`, so the service role is the
   only way in. That is the point of the model rather than an accident of it: if
   a user session could reach this function, a user could assert their own
   Skatteverket authorisation, which is exactly the claim the table exists to
   refuse.

Escalation surface: the function derives the status from the observation rather
than accepting one, refuses an unknown observation kind, and will not let a
`manual_attestation` overwrite an `skv_response`. A caller who controlled every
argument could at most record a verdict about a company they already had write
access to — and the verdict is what the provider's own response said, since the
only two call sites (`writeSkatteverketAudit`, `writeApiRequestEnd`) derive it
from the HTTP outcome and pass `null` for everything that is not a verdict.

No tenant boundary is crossed: both statements are keyed by the same
`company_id`, and nothing here reads or writes another company's rows.
