# Testresultat

> **Status: historical delivery record, archived 2026-07-30.**
>
> Test counts as of 2026-07-30. **The numbers below are not current** — the unit suite has grown by roughly a hundred files since. Run `npm run verify:fast` for the live figures.
>
> It lived in the repository root until 2026-08-21, where it read as current
> guidance. Moving it here is the fix for that, not a re-endorsement.

| Kontroll | Resultat |
|---|---|
| TypeScript | PASS, 0 fel |
| Riktade bokslutstester | PASS, 47/47 |
| Full unit-svit | PASS, 6 114 pass / 2 skip |
| Lintbaseline | PASS, 0 nya fel |
| Antipattern-guard | PASS |
| PostgreSQL-parser | PASS, 49 statements |
| Next-produktionsbygge | PASS, 355 sidor |
| `git diff --check` | PASS |
| Live migration | Inte körd: DB-URL saknas |
| pg-real/RLS | Inte körd: PostgreSQL saknas |

Ej körda kontroller räknas inte som godkända.
