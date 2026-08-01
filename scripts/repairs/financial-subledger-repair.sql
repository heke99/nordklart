-- SAFE TWO-STEP RUNBOOK. Do not skip the dry-run.
-- Replace the UUIDs/reason below. The function only repairs the unambiguous
-- classification `stale_invoice_fields`; conflicts, missing JEs, duplicate bank
-- links, overallocations and cancelled entries remain manual-review cases.

-- 1. Dry-run (writes only an audited repair-run record, no invoice mutation):
SELECT public.run_financial_subledger_repair(
  '00000000-0000-0000-0000-000000000000'::uuid, -- actor_user_id
  '00000000-0000-0000-0000-000000000000'::uuid, -- company_id
  'Reconcile verified stale invoice aggregates after reviewed discrepancy report',
  false,
  100
);

-- 2. After accounting review, change false -> true and run the same batch.
-- Re-running is idempotent: repaired rows disappear from the candidate view.
