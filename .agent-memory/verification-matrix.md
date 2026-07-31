# Verifieringsmatris

| Kontroll | Kommando/metod | Utfall |
|---|---|---|
| Typkontroll | `NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck` | PASS, 0 fel |
| Riktade workpaper/readiness-tester | 2 filer | PASS, 16/16 |
| Full unit-svit | `npm test` | PASS, 6 112 pass / 2 skip |
| Ändrade filer ESLint | `npx eslint <ändrade ts/tsx>` | PASS, 0 fel |
| Lintbaseline | `npm run check:lint` | PASS |
| Guards | `npm run check:guards` | PASS, avrundning −13 |
| Produktionsbygge | generatorer + `next build`, build-only fontmocks | PASS, 355 sidor |
| PostgreSQL-syntax | `pgsql-parser` | PASS, 44 statements |
| Migrationsordning | `npm run db:migrate:list` | PASS, ny migration #420 |
| Gamla migrationer | Git-diff mot mottagen baslinje | PASS, inga gamla migrationsfiler ändrade |
| Dubbla migrationsversioner | lokal versionskontroll | FAIL, 2 befintliga dubletter |
| Migrationsstatus | `npm run db:migrate:status` | NOT RUN, DB-URL saknas |
| pg-real/RLS | `npm run test:pg` | NOT RUN, `ECONNREFUSED :5432` |
| Import/bokslut/återimport | pg-real-scenarier tillagda | NOT RUN, PostgreSQL saknas |
| Routing | Next route-manifest + readiness unit-test | PASS, sida/API och period/company/focus finns |

Ej körda kontroller räknas inte som godkända.

## Kanonisk bokslutskedja 2026-07-30

| Kontroll | Kommando/metod | Utfall |
|---|---|---|
| Typkontroll | `NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck` | PASS, 0 fel |
| Riktade bokslutstester | 4 filer | PASS, 47/47 |
| Full unit-svit | `npm test` | PASS, 6 114 pass / 2 skip |
| Lintbaseline | `npm run check:lint` | PASS, 0 nya fel |
| Guards | `npm run check:guards` | PASS |
| PostgreSQL-syntax | `libpg-query` | PASS, 49 statements |
| Produktionsbygge | `NODE_OPTIONS=--max-old-space-size=4096 npx next build` | PASS, 355 sidor |
| Git whitespace | `git diff --check` | PASS |
| Live migration | `npm run db:migrate` | NOT RUN, DB-URL saknas |
| pg-real/RLS/transaktion | `npm run test:pg` | NOT RUN, PostgreSQL saknas |

## Slutförandereparation 2026-07-30

| Kontroll | Kommando/metod | Utfall |
|---|---|---|
| Typkontroll | `NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck` | PASS, 0 fel |
| Full unit-svit | `npm test` | PASS, 488 filer / 6 120 tester; 1 fil och 2 tester skip |
| Lintbaseline | `npm run check:lint` | PASS, 0 nya fel |
| Guards | `npm run check:guards` | PASS, naiv öresavrundning −15 |
| Feature-policy | direkt körning av kontrollskriptet | PASS, 465 routes / 296 operationer |
| PostgreSQL-syntax | `pgsql-parser` | PASS, 35 statements |
| Migrationsordning | `npm run db:migrate:list` | PASS, migration 423 sist |
| Produktionsbygge | generatorer + `next build` | PASS, 356 routes/sidor |
| Live migration | `npm run db:migrate` | NOT RUN, DB-URL saknas |
| pg-real/processorer | `npm run test:pg` | NOT RUN, PostgreSQL saknas |

## Exekveringskontrakt 2026-07-31

| Kontroll | Kommando/metod | Utfall |
|---|---|---|
| Installation | `npm ci --cache /tmp/nordklart-npm-cache` | PASS, 1 120 paket |
| Typkontroll | `NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck` | PASS, 0 fel |
| Full unit-svit | `npm test -- --run` | PASS, 490 filer / 6 128 tester; 1 fil och 2 tester skip |
| Ändrade filer ESLint | `npx eslint <ändrade ts/tsx>` | PASS, 0 fel/varningar |
| Full lint | `npm run lint` | PASS, 0 fel; 226 befintliga varningar |
| Guards | `npm run check:guards` | PASS, naiv öresavrundning −15 |
| Feature-policy | `node --import tsx scripts/check-feature-policy-coverage.ts` | PASS, 465 routes / 296 operationer |
| PostgreSQL-syntax | `pgsql-parser` | PASS, 42 statements |
| Produktionsbygge | generatorer via `node --import tsx` + `next build` | PASS, 356 routes/sidor |
| Migrationsstatus | `npm run db:migrate:status` | BLOCKED, DB-URL saknas |
| pg-real | `npm run test:pg` | BLOCKED, `ECONNREFUSED localhost:5432`; 75 filer ej körda |

Blockerade kontroller räknas inte som godkända.
