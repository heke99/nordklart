# Verifieringsmatris

| Kontroll | Kommando/metod | Senaste utfall |
|---|---|---|
| Typkontroll | `NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck` | PASS, 0 fel |
| Riktade tester | readiness, accrual-route och featurepolicy-unit | PASS, 34/34 |
| Full unit-svit | `TZ=Europe/Stockholm npm test` | PASS, 6 098 pass / 2 skip |
| Full ESLint | `TZ=Europe/Stockholm npm run lint` | PASS, 0 fel / 226 varningar |
| Lintbaseline | `npm run check:lint` | PASS, 0 nya fel |
| Guards | `npm run check:guards` | PASS, 167 / 653 |
| Featurepolicy | `node --import tsx scripts/check-feature-policy-coverage.ts` | PASS, 461 routes / 292 operationer |
| SQL-syntax | PostgreSQL `libpg_query`-parser | PASS, 43 satser |
| Produktionsbygge | generatorer + `next build` | PASS, 354 sidor |
| pg-real/RLS | separat PostgreSQL-testdatabas | NOT RUN, databas saknas |
| Live migration | mål-DB | NOT RUN, anslutning saknas |

Skippade tester och kontroller utan miljö räknas inte som godkända.
