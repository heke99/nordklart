# Canonical historical year-end workpapers

Date: 2026-07-30

## Outcome

Nordklart now has one persisted workpaper model for balances that can be
derived from an imported SIE ledger. A missing historical support register is
represented as unknown (`NULL`), never as zero. The user can confirm several
imported balances in one operation without creating a journal entry, while a
real difference remains blocking and an accounting correction is routed to the
ordinary journal-entry flow.

The existing SIE identity/session pipeline, historical AR/AP registers,
external evidence tables, manual bank reconciliation, canonical
`year_end_control_status`, `year_end_db_blockers`, and atomic close RPC remain
the foundation. The new migration layers the workpaper semantics over those
controls, so the UI and the transaction-internal close continue to use the same
database blocker engine.

## Root causes corrected

1. `year_end_control_status` treated an absent AR/AP register as a zero-valued
   register. A non-zero SIE ledger balance therefore appeared as a false
   difference or generic completion error.
2. Imported ledger balances had no canonical per-area confirmation record.
   Users were pushed toward reconstructing data that was already posted.
3. Readiness rendered confirmation tasks together with accounting errors, so a
   missing historical object looked like a broken ledger.
4. Source precedence and reimport decisions were not persisted in one place.
5. The support page did not provide a bulk confirmation flow or show the
   canonical source, status, mapped accounts, and reimport conflict together.

## Canonical model

`year_end_historical_workpapers` has one row per company, fiscal period, and
area. It stores:

- SIE import provenance and imported/current/external amounts;
- nullable actual difference;
- source and source priority;
- mapped account numbers and ledger fingerprint;
- confirmation, verification, and comment fields;
- an explicit pending reimport conflict;
- tenant, period, actor, and audit metadata.

`year_end_historical_workpaper_events` is append-only. It records generation,
refresh, confirmation, external verification, manual adjustment, detected
differences, and reimport decisions.

The source order is:

1. manual adjustment (`500`);
2. verified external evidence (`400`);
3. internal itemized support register (`300`);
4. accepted/imported SIE (`250`/`200`);
5. system calculation.

A completed SIE import refreshes the workpapers. Existing stronger sources are
not overwritten. A changed reimport becomes a pending conflict that requires
an explicit keep/replace decision. The unique constraint prevents duplicate
workpapers and an advisory transaction lock serializes refresh/accept flows.

## Status and blocker semantics

- `automatically_reconciled`: derived or backed by a matching stronger source.
- `imported_from_sie`: ledger amount is known; historical detail is unknown.
- `sie_balance_accepted`: a user confirmed the SIE amount; no journal created.
- `external_evidence_verified`: external evidence matches the ledger.
- `manually_adjusted`: workpaper metadata/presentation was adjusted.
- `actual_difference`: two explicit amounts differ.
- `completion_required`: a required non-ledger fact is missing.
- `blocking_accounting_error`: the ledger or another accounting invariant is
  invalid.

The readiness UI groups these as **Klart automatiskt**, **Behöver bekräftas**,
and **Måste åtgärdas**. A confirmation can block final close until performed,
but it is not labelled as an accounting error. `year_end_db_blockers` still
reads `year_end_control_status`, and the atomic close still invokes that same
blocker function inside its locked transaction.

## Write paths and accounting safety

- Bulk SIE acceptance updates workpapers and audit events only.
- External evidence refreshes the canonical workpaper after the existing
  evidence RPC succeeds.
- Manual changes must specify their classification.
- `accounting_correction` is rejected by the workpaper API and database RPC;
  it must use a real correction voucher.
- Service-only RPC grants, route-level company/period access checks, RLS read
  policies, foreign keys, decimal constraints, and append-only audit triggers
  enforce the boundary below the UI.

## Migration and backfill

Run, in order:

1. `20260729160000_sie_identity_parse_sessions_and_corrections.sql`
2. `20260729161000_historical_ar_ap_support_ledgers.sql`
3. `20260729162000_historical_year_end_controls_and_atomic_close.sql`
4. `20260730110000_canonical_historical_year_end_workpapers.sql`

The final migration contains its own idempotent backfill for the latest
completed import per company/fiscal period. No separate write backfill is
required. The read-only diagnostic script can be run afterwards to review
unknown support, actual differences, conflicts, provenance, duplicates, and
canonical control routing.

## Verification performed

- TypeScript: passed with `NODE_OPTIONS=--max-old-space-size=4096`.
- Changed-file ESLint: passed.
- Repository lint ratchet: passed with zero new errors.
- Antipattern guard: passed.
- Unit tests: 6,112 passed; 2 skipped.
- Focused workpaper/readiness tests: 16 passed.
- Migration ordering: the new migration is number 420 and follows the three
  historical year-end migrations above.
- PostgreSQL syntax: accepted by the PostgreSQL parser as 44 statements.
- Production build: passed after replacing unavailable Google Font downloads
  with build-only mock responses; all 355 static pages were generated and the
  historical-support page/API routes were present.
- PostgreSQL integration tests: attempted but not executed because no
  PostgreSQL server was available at `localhost:5432`
  (`ECONNREFUSED`). Run the supplied commands against a bootstrapped test
  database before deployment.

## Remaining deployment risk

The migration and pg-real scenarios still need execution against the target
PostgreSQL/Supabase version. The migration is forward-only and parser-checked,
but production deployment should remain gated on:

1. bootstrapping all migrations in an empty test database;
2. running the pg-real suite, especially the historical support and atomic
   close tests;
3. running the diagnostic SQL after backfill;
4. testing one real SIE import, one changed reimport, and one concurrent close
   in staging.

