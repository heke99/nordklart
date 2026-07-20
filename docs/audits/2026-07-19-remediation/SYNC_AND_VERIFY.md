# SYNC_AND_VERIFY — Revisionsåtgärder 2026-07-19

Denna leverans åtgärdar samtliga punkter B01–B14, R01–R21, I01–I24, K01–K16,
A01–A10 och T01–T05 ur `Nordklart_teknisk_revisionsrapport_2026-07-18(1)`.
Punktmatrisen finns i [`POINT_MATRIX.md`](./POINT_MATRIX.md).

## 1. Synka ändringarna

Ändringarna levereras som git-branchen `cursor/audit-remediation-full-0554`
(PR mot `main`). För en miljö utan git-åtkomst kan en patch-zip skapas från
branchen och synkas med rsync ovanpå projektroten (inga extra kapslade mappar):

```bash
# Från ett repo med branchen utcheckad:
git diff --name-only main...cursor/audit-remediation-full-0554 > /tmp/changed-files.txt
git archive cursor/audit-remediation-full-0554 $(cat /tmp/changed-files.txt) -o /tmp/nordklart-remediation.zip

# På målsystemet (packa upp i en tom katalog och synka):
mkdir -p /tmp/nordklart-patch && cd /tmp/nordklart-patch
unzip /tmp/nordklart-remediation.zip
rsync -av --checksum ./ /path/to/nordklart/
```

### Borttagna filer

Följande fil har bytt namn och den gamla ska raderas vid manuell synk:

| Raderas | Ersätts av |
|---|---|
| `middleware.ts` | `proxy.ts` (Next.js 16 `proxy`-konvention, T05) |

Borttagna funktioner (ingen filradering): `importVouchers`,
`createOpeningBalanceEntry` och `resyncNextPeriodOpeningBalance` i
`lib/import/sie-import.ts` är ersatta av `lib/import/sie-staging.ts` +
`finalize_sie_import`-RPC:n.

## 2. Databas — migrationsordning

Migreringarna är framåtriktade och körs i filnamnsordning EFTER samtliga
befintliga migreringar (t.o.m. `20260715190001`):

1. `supabase/migrations/20260716120000_year_end_atomic_close.sql`
   — `year_end_runs`, `currency_revaluation_runs/items`, unika partiella index
   (en posted `year_end`/`opening_balance`/`currency_revaluation` per period),
   `year_end_db_blockers()`, `post_currency_revaluation()`,
   `execute_year_end_closing()`, source_type `currency_revaluation_reversal`.
2. `supabase/migrations/20260716130000_sie_import_provenance_engine.sql`
   — `journal_entries.sie_import_id` + `external_reference` (+ backfill),
   deferred balansvakt för direktinsatta posted-poster, `sie_import_staging`,
   `finalize_sie_import()`, `complete_sie_import()`, härdade
   `undo_sie_import()`/`replace_sie_import()`, sie_imports-statusmaskin.
3. `supabase/migrations/20260716140000_bank_import_rows_sync_status_rls.sql`
   — `bank_file_imports`-statusmaskin + options + arkivsökväg,
   `bank_file_import_rows`, `bank_sync_runs`-statusar, viewer-läsläge (RLS)
   på `transactions`/`bank_connections`/`bank_file_imports`/`cash_accounts`.
4. `supabase/migrations/20260716150000_arsredovisning_submission_narrative_hardening.sql`
   — payload-hash/idempotensnyckel/arkivkoppling på
   `arsredovisning_submissions`, `arsredovisning_narrative_confirmations`
   (append-only), `company_entity_type()` + spegel-trigger.
5. `supabase/migrations/20260716160000_bank_files_bucket.sql`
   — `bank-files` storage-bucket (WORM) för originalfilarkivering.

Kör med den befintliga migratorn:

```bash
npm run db:migrate
```

**Inkompatibel data:** migration 1 avbryter med ett riktat fel om någon period
redan har fler än en posted `year_end`/`opening_balance`/`currency_revaluation`-
verifikation — dessa måste reverseras manuellt innan migreringen körs om.
Ingen migration korrigerar data tyst.

## 3. Verifieringsfrågor efter migrering

```sql
-- Alla nya funktioner finns
SELECT proname FROM pg_proc WHERE proname IN (
  'execute_year_end_closing', 'year_end_db_blockers', 'post_currency_revaluation',
  'finalize_sie_import', 'complete_sie_import', '__sie_post_voucher',
  '__sie_delete_import_entries', 'company_entity_type');
-- förväntat: 8 rader

-- Unika skydd på plats
SELECT indexname FROM pg_indexes WHERE indexname IN (
  'journal_entries_one_year_end_per_period',
  'journal_entries_one_opening_balance_per_period',
  'journal_entries_one_currency_revaluation_per_period',
  'journal_entries_sie_import_external_ref',
  'year_end_runs_one_closed_per_period',
  'arsredovisning_submissions_idempotency');
-- förväntat: 6 rader

-- Deferred balansvakt för posted-INSERT
SELECT tgname, tgdeferrable, tginitdeferred FROM pg_trigger
WHERE tgname = 'check_balance_on_posted_insert';
-- förväntat: 1 rad, deferrable = t, initdeferred = t

-- Viewer-läsläge på banktabeller
SELECT polname FROM pg_policy
WHERE polrelid = 'public.transactions'::regclass AND polcmd IN ('a','w','d');
-- förväntat: transactions_insert/update/delete (alla via user_can_write_company)

-- Ingen förlorad data: inga poster utan status, inga föräldralösa staging-rader
SELECT count(*) FROM public.sie_import_staging s
LEFT JOIN public.sie_imports i ON i.id = s.import_id WHERE i.id IS NULL;
-- förväntat: 0
```

## 4. Testbootstrap (T02)

`npm run test:pg` kör mot `DATABASE_URL`
(default `postgresql://postgres:postgres@localhost:5432/postgres`).
Bygg en färsk databas från SAMTLIGA migreringar:

```bash
# Supabase-image ELLER ren PostgreSQL 15/16 med pgvector + pg_cron:
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:pg:bootstrap
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:pg
```

För ren PostgreSQL applicerar bootstrap-skriptet automatiskt
`tests/pg/bootstrap-plain-postgres.sql` (auth-schema, roller,
supabase_realtime-publikation, extensions i `extensions`-schemat).

## 5. Fullständig verifieringssvit

```bash
npm ci --no-audit --no-fund
npm run typecheck        # tsc --noEmit — 0 fel
npm run lint             # eslint — 0 fel (baseline = 0)
npm run check:lint       # regressionsgrind — grön
npm run check:guards     # antipattern-grind — grön
npm run check:feature-policy
npm test                 # unit: 477 filer / ~6070 tester
npm run test:pg          # pg-real: 76 filer / ~480 tester (kräver DATABASE_URL)
npm run build            # NODE_OPTIONS=--max-old-space-size=4096 next build
```

## 6. Rollback / återställning

* **Kod:** `git revert` av leverans-commitarna på branchen, eller checka ut
  `main`. `proxy.ts` kan namnändras tillbaka till `middleware.ts` med
  `export function middleware(...)` om Next-versionen skulle nedgraderas.
* **Databas:** migreringarna är additiva (nya tabeller/kolumner/funktioner/
  index/policies). Vid behov av rollback:
  1. Återställ funktionskropparna från närmast föregående migrering
     (`undo_sie_import` ← `20260528120100`, `replace_sie_import` ←
     `20260526120000`).
  2. `DROP TRIGGER check_balance_on_posted_insert ON public.journal_entries;`
     (OBS: öppnar åter I03-hålet — gör bara vid akut driftproblem.)
  3. Nya tabeller (`year_end_runs`, `currency_revaluation_runs/items`,
     `sie_import_staging`, `bank_file_import_rows`,
     `arsredovisning_narrative_confirmations`) kan lämnas kvar tomma — de
     påverkar inte äldre kod.
  4. Nya kolumner är nullable/med default och är bakåtkompatibla.
  * Bokförda poster raderas ALDRIG vid rollback (BFL) — de nya unika indexen
    kan droppas med `DROP INDEX` om äldre kod måste återinföras.

## 7. Kvarvarande risker / ej live-verifierat

* **Bolagsverket-inlämning** och **Enable Banking PSD2** kan inte köras
  end-to-end utan riktiga credentials. Kontrakten är implementerade och
  täckta av mock-/kontraktstester (`submission-service.test.ts`,
  `enable-banking/**/__tests__`); det som återstår att live-verifiera är
  själva nätverksanropen mot test-/produktionsmiljöerna.
* **K3 digital inlämning** är avsiktligt ospårad kapabilitet (R12):
  API:et svarar med strukturerad kod `K3_DIGITAL_SUBMISSION_NOT_SUPPORTED`
  och PDF-flödet är komplett. iXBRL för K3 är inte implementerat i denna batch.
* **Riksbanken-kurser** hämtas live vid valutaomvärdering; snapshot-nyckeln
  gör omkörningar deterministiska för samma kurser, men kursernas korrekthet
  beror på extern källa.
