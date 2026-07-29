# Verifieringsmatris

| Kontroll | Kommando/metod | Utfall |
|---|---|---|
| Typkontroll | `NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck` | PASS, 0 fel |
| Riktade tester | 5 filer | PASS, 41/41 |
| Full unit-svit | `npm test` | PASS, 6 109 pass / 2 skip |
| Ändrade filer ESLint | `npx eslint <ändrade ts/tsx>` | PASS, 0 fel |
| Lintbaseline | `npm run check:lint` | PASS |
| Guards | `npm run check:guards` | PASS, avrundning −13 |
| Produktionsbygge | generatorer + `next build` | PASS, 355 sidor |
| Gamla migrationschecksummor | SHA-256 mot mottagen baslinje | PASS, 417/417 oförändrade |
| Dubbla migrationsversioner | lokal versionskontroll | FAIL, 2 befintliga dubletter |
| Migrationsstatus | `npm run db:migrate:status` | NOT RUN, DB-URL saknas |
| pg-real/RLS | nytt pg-real-test | NOT RUN, `ECONNREFUSED :5432` |

Ej körda kontroller räknas inte som godkända.
