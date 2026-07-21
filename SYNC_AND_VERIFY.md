# Nordklart – synk och verifiering

Den här zippen är en **partiell patch**. Använd inte `rsync --delete`.

## 1. Synka filerna

```bash
set -euo pipefail

PROJECT="/Users/hekmath/Desktop/Projects/nordklart"
PATCH_ZIP="$HOME/Downloads/nordklart-year-end-complete-patch-20260720-v2.zip"
PATCH_DIR="/tmp/nordklart-year-end-complete-patch-v2"

rm -rf "$PATCH_DIR"
mkdir -p "$PATCH_DIR"
unzip -o "$PATCH_ZIP" -d "$PATCH_DIR"

rsync -av \
  "$PATCH_DIR/" \
  "$PROJECT/"

cd "$PROJECT"
```

`--delete` ska inte användas. Patchen innehåller endast ändrade/tillagda filer och inga raderingar.

## 2. Installera beroenden

```bash
npm ci --no-audit --no-fund
```

## 3. Kontrollera migrationsplanen

```bash
npm run db:migrate:status
npm run db:migrate:list
```

Nya migreringar ska köras i denna ordning:

1. `20260720120000_year_end_period_access_and_atomic_creation.sql`
2. `20260720123000_sie_undo_replace_reversal_only.sql`
3. `20260720130000_year_end_fx_database_verification.sql`
4. `20260720133000_year_end_readiness_reconciliation_hardening.sql`

Kör dem med projektets migrationsrunner:

```bash
npm run db:migrate
npm run db:migrate:status
```

## 4. Verifiera

```bash
npm run typecheck
npm run lint
npm run check:lint
npm run check:guards
npm run check:feature-policy
npm run test
```

PostgreSQL-testerna kräver en separat testdatabas som kan byggas från samtliga migreringar:

```bash
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres"
npm run test:pg:bootstrap
npm run test:pg
```

Kör slutligen produktionsbuild:

```bash
npm run build
```

## 5. Riktad kontroll av den här patchen

```bash
npx vitest run --project unit \
  lib/year-end/__tests__/period-access.test.ts \
  lib/year-end/__tests__/access.test.ts \
  app/api/bookkeeping/fiscal-periods/__tests__/route.test.ts \
  lib/import/__tests__/access.test.ts \
  lib/import/__tests__/sie-import.test.ts \
  lib/bookkeeping/__tests__/currency-revaluation.test.ts \
  lib/reports/__tests__/monthly-breakdown.test.ts \
  lib/reports/__tests__/pagination-2500.test.ts \
  lib/bokslut/formal-report/__tests__/k2-model.test.ts
```

För riktade databasfall:

```bash
VITEST_PG_REAL=1 npx vitest run --project pg-real \
  lib/year-end/__tests__/fiscal-year-creation.pg.test.ts \
  lib/import/__tests__/sie-import-engine.pg.test.ts \
  lib/import/__tests__/sie-import.replace.pg.test.ts \
  lib/core/bookkeeping/__tests__/year-end-atomic-close.pg.test.ts \
  lib/core/bookkeeping/__tests__/year-end-readiness-reconciliation.pg.test.ts
```

## Rollback

Migreringarna innehåller ekonomiska tabeller, constraints och RPC:er. Kör inte automatisk nedmigration i produktion. Vid problem:

1. stoppa nya boksluts-/SIE-körningar;
2. återställ applikationsfilerna med Git;
3. återställ databasen från backup eller använd en separat, granskad framåtriktad korrigeringsmigration;
4. hårdradera aldrig bokförda verifikationer eller stornoverifikationer.
