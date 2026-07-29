# Testresultat

Datum: 2026-07-29

## Slutförda kontroller

| Kontroll | Resultat |
|---|---|
| `npm ci --no-audit --no-fund` | PASS, 1 120 paket |
| `NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck` | PASS, 0 typfel |
| ESLint på ändrade TS/TSX-filer | PASS, 0 fel / 10 varningar |
| `npm run check:lint` | PASS, 0 nya fel mot baseline |
| `npm run check:guards` | PASS |
| Riktade SIE/AR/årsredovisningstester | PASS, 41/41 |
| `npm run test -- --run` | PASS, 486 filer / 6 109 tester; 1 fil och 2 tester skip |
| Next-produktionsbygge | PASS, 355 sidor |
| Befintliga migrationschecksummor | PASS, 416/416 SQL-filer oförändrade |
| Nya migrationsversioner | PASS, tre unika och stigande versioner |

Guards rapporterade `raw-route-auth: 167`, `naive-ore-round: 640`, två exakt
allowlistade äldre dubblettuppsättningar och en förbättring på 13
avrundningsförekomster jämfört med baseline.

Standardkommandot `npm run build` kunde inte starta sin förgenerator i
sandboxen eftersom `tsx` inte fick skapa sin IPC-socket (`EPERM`). Samma
projektsteg kördes utan IPC-wrapper och hela Next-bygget slutfördes:

```bash
node --import tsx scripts/generate-extension-registry.ts
node scripts/inject-public-branding.mjs
NODE_OPTIONS=--max-old-space-size=4096 npx next build
```

## Databasberoende kontroller

| Kontroll | Resultat |
|---|---|
| `npm run db:migrate:status` | INTE KÖRD — `SUPABASE_DB_URL`/`DATABASE_URL` saknas |
| pg-real-test för historiska stödregister | BLOCKERAD — `ECONNREFUSED` på localhost:5432 |
| Full `npm run test:pg` | INTE KÖRD — PostgreSQL saknas |
| RLS- och concurrency-tester mot riktig PostgreSQL | INTE KÖRDA |
| End-to-end bokslut mot migrerad databas | INTE KÖRT |

Det nya pg-real-testet innehåller fyra tester, bland annat `staged`-blockering
och AR/AP utan nya verifikationer. De kunde inte ges PASS utan en riktig
databas.

## Migrationskontroll

- Inga av de 416 befintliga SQL-migrationerna har ändrats eller försvunnit.
- Följande äldre dubblettversioner fanns redan i källprojektet:
  - `20260629120000`
  - `20260704120000`
- De nya versionerna är unika:
  - `20260729160000`
  - `20260729161000`
  - `20260729162000`

## Kommandon för slutlig miljöverifiering

```bash
npm ci
export SUPABASE_DB_URL='postgresql://...'
npm run db:migrate:status
npm run db:migrate
npm run test:pg
npm run nordklart:platform-accounting-regression
NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck
npm run lint
npm run check:guards
npm run check:lint
npm test
npm run build
```
