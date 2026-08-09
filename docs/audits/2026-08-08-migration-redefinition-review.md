# Migration redefinition review — 2026-08-08

Scope: every accounting- and security-critical database object defined more than
once in `supabase/migrations/`, compared chronologically and against the live
catalog.

## Why this review exists

`CREATE OR REPLACE FUNCTION f` replaces `f`. Every branch, status value,
authorization check, GUC carve-out and `search_path` pin the previous definition
had is gone unless the new body restates it. Six production incidents in this
repository came from that single mechanic, each a later migration that rewrote a
function in full and silently dropped a case:

| Incident | Object | What the rewrite dropped |
|---|---|---|
| #4 | `mark_entry_as_opening_balance` / `enforce_journal_entry_immutability` | the `nordklart.allow_source_type_retag` GUC carve-out |
| #5 | `delete_last_voucher` | the ability to clear `reversed_by_id` on un-reversal |
| #8 | `year_end_db_blockers` | `imported_from_sie` from the blocker suppression list |
| #9 | `settle_customer_invoice` | committed with a `commit_method` its own CHECK forbade |
| #10 | `settle_supplier_invoice` | same |
| #16 | `__year_end_prior_result_transfer` | same — found by this review |

## Inventory

253 objects are defined in more than one migration. The 41 whose redefinition
can produce wrong bookkeeping, a security hole or a blocked economic flow are
tracked in `supabase/critical-object-redefinitions.json` (122 definitions).

The most-redefined critical objects:

| Definitions | Object |
|---:|---|
| 12 | `enforce_journal_entry_immutability` |
| 7 | `match_batch_allocate` |
| 7 | `year_end_db_blockers` |
| 6 | `execute_year_end_closing` |
| 5 | `commit_journal_entry`, `validate_and_increment_api_key`, `write_audit_log`, `resolve_company_access`, `enforce_journal_entry_line_immutability`, `enforce_retention_journal_entries` |

## Method

Two passes, because they answer different questions.

**Chronological.** For each critical object, every definition in chain order,
comparing the token classes whose disappearance is what the known bugs look
like: string literals, structured error codes, authorization calls, GUC
carve-outs, `search_path` pins and writes to state columns. 35 redefinitions
dropped at least one token relative to an earlier version — which is expected,
since a later migration may legitimately move logic elsewhere.

**Against the live catalog.** The decisive pass: tokens present anywhere in an
object's history but absent from the definition that actually survived. This is
what distinguishes "moved" from "lost".

## Findings

Four objects showed tokens present in history but absent live. All four were
verified individually and are refactors, not regressions.

**`year_end_db_blockers`** — lost `draft`, `posted`, `reversed`,
`partially_paid`, `opening_balance`. The checks moved into a delegation chain:
`year_end_db_blockers` → `__year_end_db_blockers_historical_core_*` →
`__year_end_db_blockers_core_20260728` → `__year_end_db_blockers_core_20260720`,
which still holds the draft check. Reachability confirmed in the catalog and
covered by a passing test (`readiness runs INSIDE the transaction and fails
closed on drafts`).

**`execute_year_end_closing`** — lost the `user_can_write_company` call. It now
delegates to `__year_end_assert_actor`, which resolves through
`resolve_company_access_for_user(...)` and requires both `can_read` and
`can_write`. That is the canonical resolver and a strictly stronger check than
the helper it replaced. Behaviour verified directly in
`year-end-journey-matrix.pg.test.ts`: a viewer, an outsider and a caller
declaring someone else as the actor are all denied.

**`replace_sie_import`** — lost `posted`, `completed`, `cancelled`, `import`.
The function was deliberately reduced to an unconditional
`SIE_REPLACE_FILE_REQUIRED` failure; replacement now runs only through the
corrected-file path. Intentional, and pinned by an existing test (`disables
direct replace without a corrected staged file`).

**`resolve_company_access`** — lost `active`. It is now a one-line delegation to
`resolve_company_access_for_user`, which contains the membership-status logic.

**One real regression, fixed.** `__year_end_prior_result_transfer` commits with
`commit_method = 'system'`, which the CHECK constraint on `journal_entries` did
not permit — the third instance of that exact defect. It fires on the second
consecutive year-end close of an aktiebolag (the 2099 → 2098 omföring), which is
why no existing test caught it: every year-end test closes a first year. Fixed
in `20260808140000`, with `tests/pg/commit-method-provenance.pg.test.ts`
comparing writers against the constraint so a fourth instance cannot land.

## Standing controls

- `npm run check:redefinition` (in `check:guards`) fails the build when the
  definition count of a tracked object changes, and prints the specific things
  to diff before acknowledging with `--write`. It does not judge correctness —
  nothing mechanical can — it refuses to let a redefinition land silently.
- `tests/pg/commit-method-provenance.pg.test.ts` compares every `commit_method`
  literal any live function writes against the CHECK constraint.
- `tests/pg/security-definer-search-path.pg.test.ts` asserts every
  `SECURITY DEFINER` function pins `search_path`, and that every pgcrypto caller
  keeps the extension schema on it.
