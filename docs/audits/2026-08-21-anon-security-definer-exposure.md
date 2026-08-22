# `anon` could execute 144 SECURITY DEFINER functions — 2026-08-21

## What was wrong

A Supabase project ships with

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
```

from both `postgres` and `supabase_admin`. `anon` is the role a PostgREST
request carries when it presents the public anon key and no session — the key
that ships in the browser bundle.

For an ordinary function that is harmless: it runs as the caller, and RLS
decides what it can reach. A `SECURITY DEFINER` function is the opposite case
by definition — it runs as the owner and RLS does not apply — so the grant *is*
the authorisation, unless the body checks for itself.

In production, 144 `SECURITY DEFINER` functions in `public` were
anon-executable. Most do check (`auth.uid()`, `require_service_role()`,
`require_platform_commercial_admin()`, …). **39 did not.**

## How it was found

Not by reading the functions. `tests/pg/bootstrap-plain-postgres.sql` granted
its default privileges to `authenticated, service_role` and omitted `anon`, so
the pg-real replay gave `anon` 2 table privileges where production gives it
~2000, and no function privileges where production gives it EXECUTE on all 392.
The replay was *safer* than production, which is the dangerous direction: a
missing guard was unreachable locally and open in production, and the suite
went green either way.

Adding `anon` to the bootstrap's defaults — making the replay faithful rather
than flattering — surfaced this immediately.

## Reproduction (against the replay, carrying production's grants)

```sql
SET ROLE anon;
SELECT public.company_entity_type('<any company id>');    -- 'aktiebolag'
SELECT public.check_email_exists('someone@example.com');  -- true / false
SELECT * FROM public.detect_voucher_gaps('<any company id>', NULL, NULL);
```

All three answer. That is a cross-tenant read of another company's data and a
user-enumeration oracle, reachable with nothing but the public key. The
unguarded list also included functions that write: `seed_chart_of_accounts`,
`finalize_sie_import`, `sync_team_to_company`, `cleanup_sandbox_user`,
`cleanup_expired_sandbox_users`, `claim_due_webhook_deliveries`, the
`provision_*_signup_draft*` family, and `validate_and_increment_api_key`.

## The fix

`supabase/migrations/20260821210000_anon_cannot_execute_security_definer.sql`
revokes EXECUTE from `anon` — and from `PUBLIC`, which anon is a member of — on
every `SECURITY DEFINER` function in `public`. 144 functions.

Adding a guard to 39 bodies would have fixed today's list and left the next one
to be found the same way. The grant is the defect: nothing in this product
calls a `SECURITY DEFINER` function as anon. Every call site goes through a
service-role client or an authenticated session — verified across `app/`,
`lib/`, `components/` and `extensions/` — and the only two public endpoints
read a view (`public_price_plans_v`) and an external API.

`authenticated` and `service_role` are untouched. The per-function `REVOKE`s
the sensitive migrations already carry stay in force on top of this.

## What holds it closed

Not the default privileges. PostgreSQL applies its own hardwired
`GRANT EXECUTE TO PUBLIC` for new functions *in addition* to `pg_default_acl`,
and `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` does
not suppress it — measured, not assumed: a freshly created `SECURITY DEFINER`
function still comes out with `=X` in its ACL and answers
`has_function_privilege('anon', …) = true`. The migration says so rather than
shipping a line that looks like it works.

What holds it closed is `tests/pg/anon-security-definer-surface.pg.test.ts`,
which fails the moment any `SECURITY DEFINER` function in `public` becomes
anon-executable again — so a migration that adds one without its own `REVOKE`
fails the suite. One of its cases deliberately creates such a function and
asserts that it *is* open, so the reason the per-function `REVOKE` is mandatory
is written down where the next person will read it.

## Blast radius considered

- Verified `authenticated` and `service_role` retain EXECUTE on the helper
  functions the RLS policies call (`user_company_ids`,
  `user_can_access_company_v2`, `resolve_company_access`, `is_platform_admin`).
  Losing those would break every authenticated query.
- Verified `public_price_plans_v` and `public_price_start_v` — the deliberate
  anon surface behind the pricing and registration pages — still read as anon.
- One behaviour change: `skatteverket_connections_v` is not `security_invoker`
  and filters on `user_company_ids()`. As anon it used to return 0 rows and now
  raises `permission denied`. Anon has no business there and no product code
  reads it without a session, so the louder failure is the better one.
- Full pg-real suite green (728) against a clean replay with the faithful
  grants; unit suite green.
