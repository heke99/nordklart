# Production content reconciliation, 2026-08-11

Project `rpajvvngvcutffwucbdy` (PostgreSQL 17.6) against a clean replay of
`origin/main` into an empty database (PostgreSQL 16).

## Why the previous method could not have found this

`scripts/reconcile-migration-ledger.mjs` decides whether a migration ran by
asking whether the objects it names exist. That is sound for a migration that
CREATEs something new and unsound for every migration that REPLACES something:
`CREATE OR REPLACE FUNCTION`, `DROP POLICY` + `CREATE POLICY` under the same
name, `ALTER FUNCTION ... SET search_path`, a rebuilt CHECK. The object exists
either way.

The previous session's report recorded the 68 unrecorded migrations as
"verified applied, fingerprint matched". This session re-verified that claim
rather than trusting it, using content instead of existence, and it did not
hold.

The new tool is `scripts/schema-fingerprint.mjs`. It hashes the definition of
every function, view, policy, trigger, constraint, index, column, RLS flag and
grant in `public`, normalising whitespace so PostgreSQL 16 and 17 pretty-print
differences do not register as drift. Comparison converges by bucketing on
`md5(identity)` so only genuinely differing slices are transferred.

## What the fingerprint found

Ten object kinds, ~9,900 objects. `rls` and `trigger` matched exactly on the
first comparison, which is what established the method was sound. Seventeen
objects differed.

| Object | Canonical | Production (before) | Class |
|---|---|---|---|
| `resolve_company_access(uuid)` | delegates to `resolve_company_access_for_user` | **older inline body** | CONTENT_MISMATCH |
| `user_company_ids()` | `archived_at is null AND user_can_access_company_v2` | omits the archived filter | CONTENT_MISMATCH |
| `company_has_feature(uuid,text)` | reads `company_feature_access` | pre-`company_feature_access` body | CONTENT_MISMATCH |
| `sync_subscription_entitlements()` | current | older body | CONTENT_MISMATCH |
| `agency_members_role_check` | includes `payroll` | lacks it | CONTENT_MISMATCH |
| `agency_invitations_role_check` | includes `payroll` | lacks it | CONTENT_MISMATCH |
| `signup_drafts_status_check` | includes `access_request_pending` | lacks it | CONTENT_MISMATCH |
| `payment_collection_events_write` | *(not defined)* | `FOR ALL` on membership | PRODUCTION_ONLY |
| `payment_provider_accounts_write` | *(not defined)* | `FOR ALL` on membership | PRODUCTION_ONLY |
| `skatteverket_company_settings_write` | *(not defined)* | `FOR ALL` on membership | PRODUCTION_ONLY |
| `year_end_purchase_access_write` | *(not defined)* | `FOR ALL` on membership | PRODUCTION_ONLY |
| `payment_collection_events_platform_write` | platform-admin only | **absent** | NOT_APPLIED |
| `payment_provider_accounts_platform_write` | platform-admin only | **absent** | NOT_APPLIED |
| `year_end_purchase_access_platform_write` | platform-admin only | **absent** | NOT_APPLIED |
| `bankgiro_applications` × 3 CHECKs | documents_status, provider_setup_status, risk_score | absent | NOT_APPLIED |
| `webhook_events` shape + `webhook_events_pkey` | PK on `code` | PK on `id` | NOT_APPLIED |
| `api_webhook_overview_v`, `company_feature_access_v` | current | downstream of `webhook_events` | NOT_APPLIED |

### The material finding

Production's `resolve_company_access()` read `company_members` **without**
`company_member_is_active(cm.status)` and joined `agency_members` **without**
`am.status = 'active'`. A suspended company member and a revoked agency
consultant therefore still resolved to a role with `can_write = true`.

This is the same defect class as finding #21 (a revoked `platform_role` that
still authorized), and it sits underneath everything: `user_can_write_company()`
delegates to this function, and that is the predicate the #19 and #22 policy
sweeps installed on ~180 write policies. The policies were correct; the
function they asked was not.

### The second finding

Four `FOR ALL` policies existed only in production, gated on
`user_can_access_company_v2(company_id)` — read-level membership. `FOR ALL`
covers INSERT, UPDATE and DELETE, and policies are OR'd, so each one re-opened
for its table exactly the hole that 20260808170000 and 20260810120000 closed
everywhere else. They were invisible to both sweeps and to the
`tenant-isolation-matrix` guard because all three filter on
`cmd IN ('INSERT','UPDATE','DELETE')` and never matched `cmd = 'ALL'`.

## What was deployed

In repository order, each through `scripts/deploy-migration-via-mcp.mjs`
(chunk-level sha256 verified server-side before execution):

| Migration | Effect |
|---|---|
| `20260713120000_agency_payroll_role` | `payroll` vocabulary + status-aware resolver |
| `20260714120000_access_hardening_agency_status_service_resolver` | `resolve_company_access` delegates to the single resolver |
| `20260811120000_converge_production_to_canonical_access_contract` | `user_company_ids`, `company_has_feature`, `sync_subscription_entitlements`, 3 CHECKs, dropped the 4 membership-level `FOR ALL` policies |
| `20260811130000_restore_platform_write_policies_and_bankgiro_checks` | 3 canonical `_platform_write` policies, 3 `bankgiro_applications` CHECKs |

Both convergence migrations are no-ops against the canonical replay — verified
by re-running the full fingerprint after applying them locally and getting
byte-identical hashes for all ten kinds. That property is what makes them safe
to carry in the chain.

### A correction made mid-flight

`20260811120000` dropped the four membership-level `FOR ALL` policies on the
assumption that production already carried the canonical replacements. It did
for `skatteverket_company_settings` (per-command policies gated on write
capability) and did **not** for the other three, which were left with a SELECT
policy and no write path. `20260811130000` restored the canonical
`_platform_write` policies. The gap was caught by re-running the count
comparison after the deploy rather than assuming the deploy was complete.

## State after this session

| Kind | Canonical | Production | Match |
|---|---|---|---|
| function (non-extension) | 281 / `06ba2d68` | 281 / `06ba2d68` | **exact** |
| rls | 277 / `c928998a` | 277 / `c928998a` | **exact** |
| trigger | 329 / `71660424` | 329 / `71660424` | **exact** |
| constraint | 1843 | 1843 | count matches, hash differs |
| policy | 635 | 635 | count matches, hash differs |
| column | 4332 | 4331 | `webhook_events` |
| index | 929 | 929 | `webhook_events_pkey` |
| view | 27 | 27 | 2 views downstream of `webhook_events` |

The authorization contract — the part that decides who may write — now matches
the repository exactly.

## Not yet closed

1. **`webhook_events` catalog shape.** Canonical keys on `code`, production on
   `id`; two views read it. `20260714160000_webhook_event_catalog_resync.sql` is
   the migration that owns this and is written to be idempotent. Not yet
   deployed.
2. **Residual constraint/policy hash difference.** Counts match, so these are
   textual rather than structural — at least one is confirmed benign
   (`skatteverket_company_settings_select` differs only in the operand order of
   `A OR B`). The remainder need the same per-object drill before being called
   equivalent. Not yet done.
3. **Ledger reconciliation.** 446 repository files, 380 ledger rows. The 66
   unrecorded are the contiguous range `20260628172000` → `20260801140000`.
   Their effects are present apart from the items above, but no rows have been
   written, and they must be written per file with evidence — never by range.
4. **The `FOR ALL` blind spot** is fixed in production but not yet in the guard:
   `tenant-isolation-matrix` still filters on
   `cmd IN ('INSERT','UPDATE','DELETE')` and would not catch a new `FOR ALL`
   policy on a read-level predicate.

Because items 1–3 are open, the correct status is **PRODUCTION NOT YET
VERIFIED**.
