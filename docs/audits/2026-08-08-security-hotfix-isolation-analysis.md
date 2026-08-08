# Security hotfix isolation analysis — 2026-08-08

Question: can findings #17 (cross-tenant view leak), #18 (`commit_journal_entry`
authorization) and #19 (read-level write policies) ship to `main` as an isolated
hotfix, ahead of the full remediation branch?

**Answer: the dependency closure is clean, but the hotfix cannot be merged
because `main` itself is not green. Ship the full branch instead.**

## Dependency closure — verified clean

Each migration was checked against the *production* schema, not against the
remediation branch's schema, because that is what the hotfix would land on.

| Migration | Requires | Present in production |
|---|---|---|
| `20260808150000` (views) | the 4 views exist | ✅ 4/4 |
| `20260808160000` (commit auth) | `user_can_write_company`, `resolve_company_access` | ✅ both |
| `20260808170000` (147 policies) | the 147 read-level policies exist unchanged | ✅ exactly 147 |

Two exactness checks, because "the objects exist" is not the same as "my
migration reproduces them faithfully":

- **`commit_journal_entry` body.** Production's `prosrc` was fetched and compared
  against the body the migration restates. Byte-identical — the migration only
  *adds* the authorization block and drops nothing. This is the check that
  matters most, since restating a body is exactly how six earlier regressions
  were introduced.
- **The 147 policies.** The generating query was run against production and the
  resulting SQL hashed: `41f6216ce60e3111d0a6510e0ce3b4e3`, identical to the
  generated section of the committed migration. Production's policy set produces
  the same statements, so the DROP/CREATE loses no condition.

None of the three depends on the other nine remediation migrations
(`20260807*`, `20260808120000/130000/140000`). They reference only objects that
predate them.

## Why it still cannot merge

`main` has **53 failing unit tests across 10 files**, measured directly on a
worktree cut from `origin/main` with only the three migrations and their tests
added. Those failures are pre-existing and are what the remediation branch
fixes.

`main`'s CI (`core-build.yml`) runs `npm test`. A PR from a branch cut from
`main` is therefore red on arrival, through no fault of the hotfix — and a red
PR must not be merged.

Making the hotfix green would mean porting the settlement service rewrite, the
mock-helper changes and the route-test conversions that fix those 53 tests. That
is substantially the entire remediation branch, so the "isolated" hotfix would
stop being isolated and would carry far more risk than shipping the branch that
was actually tested as a whole.

Also worth recording: **no workflow in this repository has ever run.** All six
workflows report zero runs, so there is no historical green baseline for `main`
at all. The first CI execution will be the remediation PR.

## Decision

Abandon the isolated hotfix. Ship the full remediation branch, which:

- carries all four security fixes (#16–#19),
- takes the unit suite from 53 failures to 0,
- takes pg-real from 509 to 640 tests,
- and is the configuration that was actually verified end to end.

The security exposure window is not extended by this decision: the hotfix could
not have been merged sooner, because it could not have gone green sooner.

## Verification commands used

```sql
-- production: object presence and policy count
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='v'
   AND c.relname IN ('customer_ar_balances','company_commercial_usage_v',
                     'agency_commercial_usage_v','company_effective_commercial_limits_v');

-- production: exact policy-SQL hash, compared against the migration file
SELECT md5(string_agg(stmt, E'\n' ORDER BY tablename, policyname)) FROM ( … ) s;
```
