# Live Supabase advisors + migration ledger — 2026-08-08

Project `rpajvvngvcutffwucbdy`. Advisor state re-fetched fresh; no figures
carried over from the previous audit.

## Reading the numbers correctly

Production is **behind this branch**. Its ledger stops at
`20260628171000`, and object probing shows it contains everything through
`20260801140000` but none of the twelve remediation migrations. Verified
directly:

```
ledger_rows          358          create_planned_draft_entry   absent
ledger_rls           false        settle_customer_invoice      present
unpinned_secdef      8            stripe lifecycle RPC         present
commit_method CHECK  lacks sie_import_reversal, atomic_*_settlement, system
```

So a live advisor finding means one of two very different things, and they must
not be conflated:

- **already fixed on this branch, pending deploy** — the finding disappears when
  the twelve migrations land;
- **not addressed** — needs work here.

Every finding below is classified against the branch's end state, measured on a
database with all 439 migrations replayed.

## Security advisors: 358 findings

| Level | Finding | Count | Status |
|---|---|---:|---|
| ERROR | `security_definer_view` | 7 | **4 fixed** (`20260808150000`), 3 accepted with reason |
| ERROR | `rls_disabled_in_public` | 1 | fixed pending deploy (`20260807120000`) |
| WARN | `authenticated_security_definer_function_executable` | 160 | reviewed — see below |
| WARN | `anon_security_definer_function_executable` | 145 | **1 real hole fixed** (`20260808160000`) |
| WARN | `function_search_path_mutable` | 33 | 0 remain for SECURITY DEFINER after `20260807120000` + `20260808130000`; 18 non-definer remain |
| WARN | `extension_in_public` | 1 | accepted |
| WARN | `auth_leaked_password_protection` | 1 | **EXTERNAL OPERATOR ACTION** |
| INFO | `rls_enabled_no_policy` | 10 | correct as-is |

### `security_definer_view` — a real cross-tenant leak

A view runs with its OWNER's privileges unless created `security_invoker = true`.
Four were superuser-owned, carried no tenant predicate, and were granted SELECT
to `authenticated`. Measured as an ordinary member of one company:

| View | Foreign rows visible |
|---|---:|
| `customer_ar_balances` | 388 (all of them) |
| `company_commercial_usage_v` | 4 433 |
| `company_effective_commercial_limits_v` | 22 165 |
| `agency_commercial_usage_v` | 104 |

`customer_ar_balances` exposes customer ids and outstanding receivables per
company — every tenant's order book, readable by every other tenant. Fixed in
`20260808150000`; after the change, foreign rows = 0 and own rows unchanged.

Three views keep definer rights for checked reasons, not by omission:
`skatteverket_connections_v` filters `user_company_ids()` in its own body; the two
`public_price_*` views are the anon-readable catalogue with no tenant data; the
discrepancy and inventory views are service_role-only (verified with
`has_table_privilege`).

### `anon`/`authenticated_security_definer_function_executable` — one real hole

305 warnings, mostly noise: trigger functions PostgREST cannot invoke, and
resolver functions that derive everything from `auth.uid()` and therefore return
nothing for `anon`. Each directly-callable, economically significant function was
checked for an internal authorization check instead of trusting the count.

`delete_last_voucher`, `create_company_with_owner`, `delete_user_account` and
`generate_invoice_number` all check membership through `auth.uid()`. **One did
not**: `commit_journal_entry` used `auth.uid()` only as an attribution fallback.
An authenticated member of any company could post another company's draft
voucher, and posted entries are immutable by law — the victim can only storno it,
leaving both vouchers in their ledger permanently. Demonstrated end to end, fixed
in `20260808160000`, and the `PUBLIC` execute grant revoked behind it (the `anon`
grant was the implicit `PUBLIC` one, so `REVOKE ... FROM anon` was a no-op).

### `rls_enabled_no_policy` — correct as-is

All ten (`financial_operation_idempotency`, `financial_outbox_events`,
`stripe_one_time_*`, `oauth_used_codes`, `skatteverket_tokens`, …) are
service-role-only tables. RLS on with no policy is deny-all for tenant roles,
which is the intended posture. Adding policies would weaken them.

### Accepted with reason

- `extension_in_public` (`btree_gist`): moving an installed extension rewrites the
  operator classes its indexes depend on. The risk of the move exceeds the risk
  of the finding, and `btree_gist` exposes no data.
- 18 non-`SECURITY DEFINER` functions with mutable `search_path`: these run with
  the caller's own privileges, so the escalation shape does not apply. Tracked,
  not urgent. Every `SECURITY DEFINER` function is pinned, enforced by
  `tests/pg/security-definer-search-path.pg.test.ts`.

## EXTERNAL OPERATOR ACTION

### 1. Enable leaked-password protection

Dashboard-only; not reachable from SQL or the management API available here.

> Supabase Dashboard → Authentication → Policies → Password protection →
> enable **"Check passwords against HaveIBeenPwned"** for project
> `rpajvvngvcutffwucbdy`.

### 2. Reconcile the migration ledger, then deploy

The ledger dry-run classifies the repository's 439 migrations against production:

| Class | Count |
|---|---:|
| RECORDED | 358 |
| APPLIED_BUT_UNRECORDED | 69 |
| NOT_APPLIED | 12 |
| CHECKSUM_MISMATCH | 0 |
| AMBIGUOUS | 0 |

**The stop condition applies, and it is understood.** The 12 NOT_APPLIED are
exactly this branch's migrations — they *should* be unapplied, because the branch
is not deployed. They are not drift.

The 69 APPLIED_BUT_UNRECORDED are the historical out-of-band gap: their objects
are present in production (spot-verified: `match_batch_allocate`,
`execute_year_end_closing`, `record_year_end_manual_cash_reconciliation`,
`settle_customer_invoice`, `stripe_apply_one_time_purchase_event`,
`year_end_previews`, `one_time_purchases`, `agent_atom_registry`), but no ledger
row records them.

Running `npm run db:migrate` before reconciling would attempt to re-apply all 81
unrecorded files, including the 69 already applied. Order matters:

```bash
# 1. Record what is already applied, up to the last one present in production.
npm run db:migrate:mark-through -- 20260801140000_production_financial_atomicity_and_billing_lifecycle.sql

# 2. Confirm the ledger now describes the database (expect only the 12 pending).
SUPABASE_DB_URL=... npm run db:ledger:reconcile

# 3. Apply this branch's twelve migrations.
npm run db:migrate

# 4. Verify.
npm run check:migrations:db
SUPABASE_DB_URL=... npm run db:ledger:reconcile   # expect 0 in every class but RECORDED
```

Step 1 is a deliberate write to production's migration authority and is left to an
operator by design — the reconciler's `--apply` is never the default, and this
sequence was not executed from here.
