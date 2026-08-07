# Nästa exakta åtgärder

Uppdaterad 2026-08-07. Ordningen är avsiktlig: gör inte 4+ innan 1–3 är gröna.

## 1. Gör pg-real grönt (blockerar allt annat)

Kör lokalt utan Docker:

```bash
apt-get install -y postgresql-16 postgresql-16-pgvector postgresql-16-cron
# shared_preload_libraries = 'pg_cron' + cron.database_name = 'postgres'
pg_ctlcluster 16 main restart
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
bash scripts/pg-test-db.sh && npm run test:pg
```

Rätta de 36 failande testerna mot det faktiska kontraktet:

1. `year-end-atomic-close.pg.test.ts` (10) — förvänta
   `YE_READINESS_BLOCKED: <reason>` i stället för `YE_NOT_READY` /
   `YE_NEXT_PERIOD_NOT_CONTIGUOUS`, och seeda bolagsfält så att
   `company_details_incomplete` inte träffar före det testade villkoret.
2. `sie-import-engine.pg.test.ts` (7) — seeda organisationsnummer så att
   `SIE_COMPANY_IDENTITY_MISSING_IN_SIE` inte maskerar `SIE_UNBALANCED` /
   `SIE_DATE_OUTSIDE_PERIOD`.
3. `mark-entry-as-opening-balance.pg.test.ts` (4),
   `year-end-historical-support.pg.test.ts` (3), därefter resten.

Stäng inte av tester och försvaga inte triggers för att få grönt. Om ett test
beskriver ett riktigt fel: rätta koden, inte testet.

## 2. Reconcilera migrationsliggaren i produktion

Efter backup, och först efter att objekten kontrollerats mot
`docs/audits/2026-08-07-live-database-verification.md` §3:

```bash
npm run db:migrate:status
npm run db:migrate:mark-through -- 20260801140000_production_financial_atomicity_and_billing_lifecycle.sql
npm run db:migrate            # applicerar 20260807120000
npm run check:migrations:db   # måste rapportera 0 oregistrerade
```

## 3. Slå på branch protection på `main`

`core-build` och `pg-real` körs nu även på push till `main`, men GitHub kan
inte kräva dem utan en ruleset. Gör båda till required checks och blockera
direktpush. Utan detta är H-01 bara halvlöst: kedjan *körs*, men den *hindrar*
inte en deploy.

## 4. Triagera Supabase-advisors

- Sätt `security_invoker = true` på `customer_ar_balances`,
  `company_commercial_usage_v`, `agency_commercial_usage_v`,
  `company_effective_commercial_limits_v` (behåll `public_price_*` som de är).
- Pinna `search_path` på de ~21 återstående funktionerna.
- Slå på `auth_leaked_password_protection`.

## 5. Stäng H-03 — betalningsatomicitet

Flytta draftskapandet i `lib/invoices/mark-paid-service.ts` och
`lib/supplier-invoices/mark-paid-service.ts` in i `settle_customer_invoice` /
`settle_supplier_invoice` så att verifikat, rader, betalning, aggregat,
banklänk, audit och idempotens delar en transaktion. Ta bort
kompensationslogiken när den är överflödig — inte före.

## 6. Bygg ut testmatrisen (H-05)

Först när 1 är grönt: concurrency (två parallella settlements → exakt en
ekonomisk effekt), samma idempotensnyckel två gånger, failure injection efter
varje delsteg, Stripe duplicate/out-of-order/refund/dispute, tenant A mot
tenant B via både SQL och API.

## 7. Kvarvarande produktarbete

Atomisk betalningsroute för migrerade AR/AP, radnivåimport av äldre
kontoutdrag, merge-UI mot Bolagsverket-snapshot.
