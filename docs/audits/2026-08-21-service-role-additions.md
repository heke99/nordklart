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
