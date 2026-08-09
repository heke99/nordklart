# Performance, cache, rate limit, error contract, observability — 2026-08-08

Five reviews that share a shape: look for the thing that is actually wrong,
fix it, and leave a guard where the finding could come back. Where nothing was
wrong, say so with the evidence rather than inventing work.

## Cache — clean, and deliberately so

The failure mode worth hunting is one tenant's data served to another out of a
cache. It is not present:

- **No `unstable_cache` and no `cache()` around tenant data.** The only
  `next: { revalidate }` in the repository is `lib/currency/riksbanken.ts`,
  caching Riksbanken's public FX rates for an hour. Not tenant data.
- **No statically rendered tenant pages.** Zero `export const revalidate` and
  zero `force-static` anywhere; 43 dashboard pages opt into `force-dynamic`
  explicitly.
- **No public `Cache-Control` on tenant responses.** The two `public, max-age`
  headers are `/.well-known/skills/index.json` and `/api/v1/openapi.json` —
  both static catalogues. Credential-bearing responses (webhook secrets,
  rotate-secret) and statutory documents (iXBRL, årsredovisning PDF) set
  `no-store, private` explicitly.

Route handlers are dynamic by default in this Next.js version, so an
intermediary cannot cache a tenant response that does not ask to be cached.

## Rate limits — one gap, fixed

`lib/auth/rate-limit-http.ts` (Upstash sliding window) is applied to the
unauthenticated and expensive surfaces: password reset, confirmation resend,
signup draft, company/price lookups, client log, sandbox seed, the Enable
Banking flows, and OAuth **client registration**.

It was **not** applied to `POST /api/mcp-oauth/token` — the endpoint that
actually issues credentials. Codes are encrypted and refresh tokens are hashed,
so this was never the only defence, but an unauthenticated endpoint doing
crypto and database work on every request should not be free to hammer, and the
asymmetry with its own sibling `/register` was an oversight rather than a
decision. Now limited to 30/min per /24, same mechanism.

Two other unauthenticated endpoints were checked and left alone with reasons:
`/api/invoices/reminders/action` is guarded by a 256-bit
`gen_random_bytes(32)` token that is single-use, and the webhook endpoints
(`/api/stripe/webhook`, `/api/peppol/inbound`,
`/api/invoice-financing/provider-webhook`) verify a signature or shared secret
constant-time before doing any work.

## Error contract — inventoried, ratcheted

The contract is `{ error: { code, message, message_en?, requestId? } }`, built
by `errorResponse` / `errorResponseFromCode`. Two properties matter and both
hold:

- **Nothing internal leaks.** Unmapped errors fall through to `INTERNAL_ERROR`
  with a fixed message; the real error goes to the log with the request id.
  Postgres errors are mapped by code, never echoed.
- **Every response is traceable.** `withRouteContext` stamps `X-Request-Id` on
  the way out, including on the auth short-circuits.

The gap is coverage, not correctness: of 471 route files, **222 use a canonical
helper and 208 still return a bare `{ error: 'text' }`**. A bare string gives a
client nothing to branch on and no id to quote in a support ticket. Converting
208 routes is a campaign, not a release blocker — so it is now a ratchet.
`adhoc-error-envelope` joins `raw-route-auth` and `naive-ore-round` in
`scripts/checks/no-new-antipatterns.mjs`: the existing 208 are baselined, and a
**new** route returning a bare string fails CI.

## Observability — sufficient, with the request id as the spine

`withRouteContext` generates `req_<uuid>` per request and threads it through a
child logger bound to `{ requestId, operation, userId, companyId }`. Every
route logs one structured completion line with duration and status, and any
unhandled throw is logged with the richest context resolved at that point. The
same id appears in the response body and the `X-Request-Id` header, so a user
report maps to a log line without guesswork.

Around that: `audit_log` is immutable and written by trigger on DML; platform
bypasses and support exports write `SECURITY_EVENT` rows before returning data
(fail-closed — an unaudited bypass aborts); `event_log` carries a 30-day TTL;
Sentry is wired via `SENTRY_DSN`.

The honest gap: there is no metrics/tracing backend, so "how many 500s in the
last hour" is a log query rather than a dashboard. That is a monitoring
decision for the operator, not a code defect, and it does not block release.

## Performance

Measured on the branch rather than asserted:

| Chain | Result |
|---|---|
| `tsc --noEmit` | needed a 4 GB heap; the default ~2 GB OOM'd on the CI runner (fixed) |
| unit suite | 6175 tests |
| pg-real suite | 640 tests, 96 s locally against real PostgreSQL |

The database side is where tenant-scale performance actually lives, and the
shape is right: every tenant table carries `company_id` with an index, RLS
predicates resolve through `user_company_ids()` / `user_can_access_company_v2()`
rather than correlated subqueries per row, and pagination goes through
`fetchAllRows()` instead of unbounded selects.

No slow-query evidence was available from production here, so no speculative
index was added. Adding indexes without a plan to justify them is how you get a
write-amplified table and no measurement to show for it.
