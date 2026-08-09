# Nordklart — live database verification (audit finding H-02)

**Date:** 2026-08-07
**Project:** Supabase `Nordklart` — ref `rpajvvngvcutffwucbdy`, region `eu-north-1`,
PostgreSQL 17.6.1.127, status `ACTIVE_HEALTHY`
**Repository baseline:** `main` @ `a8dee572969d37295b714460bf326d386e39f673`
**Method:** read-only SQL through the Supabase connector, plus the Supabase
security advisor. No DDL and no data changes were made.

The 2026-08-06 consistency audit could not reach a Nordklart Supabase instance
and recorded H-02 as an unverified gap. The instance was reachable for this
remediation, so H-02 is now answered with evidence rather than inference.

---

## 1. Headline result

The production schema **is ahead of its own migration ledger**. The financial
hardening that H-03/H-04 depend on is present in the database, but the registry
cannot prove it — 68 repository migrations have no row recorded.

| Measure | Value |
|---|---:|
| `public` base tables | 273 |
| Tables with RLS enabled | 272 |
| RLS policies | 625 |
| `public` functions | 466 |
| Rows in `public.nordklart_schema_migrations` | 358 |
| Migration files in `supabase/migrations/` | 426 |
| **Files with no registry row** | **68** |

---

## 2. Migration ledger drift

`supabase_migrations.schema_migrations` **does not exist** in this project.
Production is migrated exclusively by `scripts/supabase-migrate.cjs`, which
writes `public.nordklart_schema_migrations` (columns: `version` — the full file
name — `checksum`, `source`, `applied_at`).

That settles the H-06 ambiguity empirically: there is only one migration
authority in production, and the Supabase CLI has never been used against it.
The two duplicate timestamp prefixes (`20260629120000`, `20260704120000`) are
therefore not ambiguous in production — the runner keys on full file names, and
both files in each pair are distinguishable. The CI guard already carries them
as a closed legacy-collision allowlist and blocks any new collision.

The last recorded migration is
`20260628171000_nordklart_workspace_runtime_contract_recovery.sql`
(`applied_at` max `2026-07-21`). Every file after it — 68 in total, including
the whole commercial/billing/Stripe stack, company authorization access
control, all canonical year-end work, and
`20260801140000_production_financial_atomicity_and_billing_lifecycle.sql` — is
absent from the ledger.

**The SQL was nevertheless applied.** Object probes confirm the hardening
migration is live (see §3). The migrations were applied out-of-band (dashboard
or `psql`) without recording a registry row. The consequence is not missing
schema; it is that **the ledger cannot be trusted to describe the database**,
which is what makes drift undetectable.

### Why this was invisible

`scripts/checks/migration-integrity.mjs --db` checked only two directions:
rows in the registry that are unknown to the repo, and checksum mismatches. It
built the set of seen files but never compared it against the repository, so
"repo file with no registry row" — the exact 68-file condition — produced no
error. That direction is now reported and fails the check.

### Required reconciliation (not performed here — it is a write)

```bash
npm run db:migrate:status                       # confirm the gap
npm run db:migrate:mark-through -- 20260801140000_production_financial_atomicity_and_billing_lifecycle.sql
npm run check:migrations:db                     # must now report 0 unrecorded
```

`mark-through` records already-applied files without re-executing them. It must
only be used after confirming each object exists (§3 is that evidence for the
final migration). Any file whose objects are *not* present must instead be
applied with `npm run db:migrate`.

---

## 3. Financial hardening — object-level verification

Every object created by
`20260801140000_production_financial_atomicity_and_billing_lifecycle.sql`
was probed by name. Present in production:

| Kind | Object |
|---|---|
| function | `settle_customer_invoice`, `settle_supplier_invoice` |
| function | `get_financial_operation_result`, `run_financial_subledger_repair` |
| function | `stripe_apply_one_time_purchase_event`, `enforce_single_bank_payment_allocation` |
| function | `resolve_year_end_period_capability_for_user` |
| table | `financial_operation_idempotency`, `financial_outbox_events`, `financial_repair_runs` |
| table | `stripe_one_time_event_applications`, `stripe_one_time_refunds`, `one_time_purchases` |
| view | `bank_payment_allocation_discrepancies_v1`, `customer_subledger_discrepancies_v1`, `supplier_subledger_discrepancies_v1` |
| unique index | `invoice_payments_bank_tx_unique`, `supplier_invoice_payments_bank_tx_unique`, `invoice_payments_company_idempotency_uidx` |

**`invoice_payments_bank_tx_review_idx` is absent.** The migration creates the
review index *only* when duplicate data blocks the unique index. Its absence
together with the presence of the unique indexes proves the migration took the
clean-data path: the unconditional uniqueness invariant is active in
production.

---

## 4. Historical data integrity (audit finding H-04)

| Discrepancy view | Rows |
|---|---:|
| `bank_payment_allocation_discrepancies_v1` | **0** |
| `customer_subledger_discrepancies_v1` | **0** |
| `supplier_subledger_discrepancies_v1` | **0** |
| `cancelled_committed_journal_entry_inventory` | **0** |

Data volume at time of verification:

| Table | Rows |
|---|---:|
| `companies` | 2 |
| `journal_entries` | 53 |
| `invoice_payments` | 0 |
| `one_time_purchases` | 0 |

H-04's feared state — historical duplicates surviving because the unique index
was skipped — **does not exist in this database**. There are no bank
allocations to duplicate and no payments at all. This database is pre-launch.

This does not make the H-04 *remediation design* unnecessary for any future
environment that already carries dirty data; it means there is nothing to
repair here, and the invariant is enforced rather than deferred.

---

## 5. Supabase security advisor

358 findings. Distribution:

| Count | Level | Lint |
|---:|---|---|
| 160 | WARN | `authenticated_security_definer_function_executable` |
| 145 | WARN | `anon_security_definer_function_executable` |
| 33 | WARN | `function_search_path_mutable` |
| 10 | INFO | `rls_enabled_no_policy` |
| 7 | ERROR | `security_definer_view` |
| 1 | ERROR | `rls_disabled_in_public` |
| 1 | WARN | `extension_in_public` |
| 1 | WARN | `auth_leaked_password_protection` |

Items that need a decision:

- **`rls_disabled_in_public`** — `public.nordklart_schema_migrations`. This is
  the migration ledger, not tenant data, and it is written by the service-role
  runner. It should still have RLS enabled with no policy so PostgREST cannot
  expose the deployment history.
- **`security_definer_view` (7)** — `customer_ar_balances`,
  `skatteverket_connections_v`, `public_price_plans_v`,
  `company_commercial_usage_v`, `agency_commercial_usage_v`,
  `public_price_start_v`, `company_effective_commercial_limits_v`. A
  `SECURITY DEFINER` view runs with the definer's rights and bypasses the
  querying user's RLS. `public_price_*` are intentionally public catalogue
  data; the `*_usage_v` and `customer_ar_balances` views are tenant-scoped and
  need review against `security_invoker = true`.
- **`function_search_path_mutable` (33)** — includes accounting-critical
  triggers (`enforce_journal_entry_line_immutability`, `next_voucher_number`,
  `enforce_company_lock_date`, `detect_voucher_gaps`,
  `enforce_retention_journal_entries`). The newer hardening migrations pin
  `search_path`; these 33 are older functions that predate that convention and
  remain object-shadowing candidates.
- **`rls_enabled_no_policy` (10)** — e.g.
  `company_registry_sync_events`. RLS on with no policy denies all access to
  non-service roles, which fails closed. Confirm each is genuinely
  service-role-only rather than an unfinished policy.
- **`auth_leaked_password_protection`** — disabled. Enable in Auth settings.

The 305 `*_security_definer_function_executable` warnings are the expected
consequence of Supabase's default `EXECUTE` grant to `anon`/`authenticated`.
The financial RPCs added by the hardening migration explicitly revoke those
roles; the warnings cover the older function surface and should be triaged
against which functions legitimately need to be callable from PostgREST.

---

## 6. Status of H-02

**Partially closed.** The connection gap is closed and the database is
characterized. What remains is a write action that must be run deliberately by
an operator:

1. Reconcile the 68-row ledger gap (§2).
2. Triage the advisor findings in §5.

Until (1) is done, `npm run check:migrations:db` will fail by design — that is
the point: the ledger genuinely does not describe the database yet.
