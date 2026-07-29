# Migrationsordning och återställning

## Förkontroller

1. Ta en verifierad databasbackup.
2. Kontrollera nuvarande migrationsstatus mot målmiljön.
3. Hantera målmiljöns befintliga migrationshistorik för de två redan existerande
   dubblettversionerna utan att byta namn på applicerade filer:
   `20260629120000` och `20260704120000`.
4. Kör plan/status igen och säkerställ att inga oväntade äldre migrationer
   väntar.

## Deterministisk ordning

Applicera exakt:

1. `supabase/migrations/20260729160000_sie_identity_parse_sessions_and_corrections.sql`
2. `supabase/migrations/20260729161000_historical_ar_ap_support_ledgers.sql`
3. `supabase/migrations/20260729162000_historical_year_end_controls_and_atomic_close.sql`

Ordningen är obligatorisk: stödregistren refererar SIE-sessionerna och den
slutliga kontroll-/stängningsmigrationen refererar båda tidigare migrationerna.
Applikationskoden ska driftsättas först när samtliga tre har applicerats.

## Rekommenderade kommandon

```bash
export SUPABASE_DB_URL='postgresql://...'
npm run db:migrate:status
npm run db:migrate
npm run db:migrate:status
npm run test:pg
```

Supabase CLI kan användas om det är projektets etablerade produktionsflöde:

```bash
npx supabase migration list --linked
npx supabase db push --linked --include-all
```

Kör inte båda migreringsmotorerna mot samma miljö utan att först verifiera att
de delar samma migrationshistorik.

## Smoke-test efter migration

- Parse av SIE med matchande respektive avvikande organisationsnummer.
- Execute från arkiverad parse-session.
- Itemiserad och extern AR/AP-avstämning med differens 0.
- Invalidation efter ändrad huvudbok eller ersatt SIE-import.
- Bokslutsblockering för `staged`.
- Två samtidiga försök att stänga samma period.
- Årsredovisning från låst företagssnapshot.

## Rollback

Ingen gammal migration ska redigeras eller tas bort. Vid rollback:

1. stoppa skrivtrafik till berörda SIE- och bokslutsflöden;
2. exportera nya sessioner, stödregister, dokumentreferenser och auditdata;
3. skapa en ny kompensationsmigration;
4. återställ de tidigare kärnfunktionerna från de versionsnamn som migrationerna
   skapade:
   `__finalize_sie_import_identity_core_20260729` och
   `__execute_year_end_closing_result_transfer_core_20260729`;
5. återkalla nya grants/policies och ta bort nya objekt i omvänd
   beroendeordning endast när datan får tas bort;
6. verifiera RLS, funktioner och migrationsstatus innan trafiken öppnas.

Att enbart rulla tillbaka applikationskoden är inte en komplett
databasrollback, men databasmigrationerna är utformade så att äldre kärnlogik
bevaras bakom versionsnamn.
