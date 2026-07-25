# Nordklart agent instructions

Read `.agent-memory/README.md` and `.agent-memory/current-state.md` before
changing code. Runtime code, the latest migration definitions and executed
tests outrank memory and historical audit reports.

## Non-negotiable invariants

- `lib/bookkeeping/engine.ts` plus database RPCs are the journal boundary.
- Posted journal entries are immutable; correct through reversal/storno.
- PostgreSQL must validate balance, period locks, tenant access and critical
  idempotency. UI checks are never sufficient.
- Resolve company access through `resolve_company_access` /
  `resolve_company_access_for_user`.
- Resolve commercial features through `company_feature_access`; never infer
  access from a plan name. A resolver failure is `database_error`, not
  `missing_entitlement`.
- Period-bound year-end access must use `requireYearEndAccess`; SIE routes must
  use the dedicated `sie_import` policy so one-time buyers work.
- Every company query, storage path, RPC and service-role action must be
  explicitly tenant-scoped.
- Use `roundOre()` from `lib/money.ts`; never add naive monetary rounding.
- Never edit an already-deployed migration to hide a production problem.

## Required workflow

1. Inspect the current call chain and latest schema definition.
2. Implement the complete safe change, including database/RLS/audit effects.
3. Add regression tests.
4. Run targeted tests, typecheck and guards; run the full suite/build for
   cross-cutting changes.
5. Update `.agent-memory/current-state.md`, `completed-work.md`,
   `open-blockers.md`, `next-actions.md`, `verification-matrix.md` and
   `session-log.md`.

Do not stop after analysis, memory setup, a scaffold or a phase summary.
