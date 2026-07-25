# Verifieringsmatris

| Kontroll | Kommando/metod | Krav |
|---|---|---|
| Typkontroll | `NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck` | 0 fel |
| Lint | `npm run lint` och `npm run check:lint` | 0 lintfel |
| Enhet/integration | `npm test` | alla icke-skip tester gröna |
| Guards | `npm run check:guards` | ingen försämrad baslinje |
| Featurepolicy | `node --import tsx scripts/generate-feature-policy-matrix.ts --check` | synkad |
| Skill bodies | `node --import tsx scripts/generate-skill-bodies.ts --check` | synkade |
| FAQ | `node --import tsx scripts/generate-faq-content.ts --check` | synkad |
| Produktionsbygge | generatorer + `next build` | lyckat bygge |
| Migrationer/RLS | mål-DB + pg-real/tenanttester | måste köras externt |

Skippade tester och kontroller som saknar miljö ska redovisas, inte räknas som
godkända.

## Senaste utfall — 2026-07-25

| Kontroll | Utfall |
|---|---|
| Typkontroll | PASS, 0 fel |
| Full unit-svit | PASS, 6 096 pass / 2 skip |
| Full ESLint | PASS, 0 fel / 228 varningar |
| Lintbaseline | PASS, 0 nya fel |
| Guards | PASS, 167 / 653 / 2 och baseline ratchetad |
| Featurepolicy | PASS, 459 routes / 289 operationer |
| Skill bodies | PASS, 108 atomer |
| FAQ | PASS, oförändrad dataset |
| Next-produktionsbygge | PASS efter huvudändring, 353 sidor; slutlig query-precisering typkontrollerad/lintad |
| Live migration/RLS/pg-real | NOT RUN, ingen mål-DB eller lokal PostgreSQL |
