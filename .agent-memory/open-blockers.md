# Aktiva blockerare och skuld

1. `SUPABASE_DB_URL`/`DATABASE_URL` saknas. De fyra nya migrationerna kan därför
   inte appliceras eller exekveras i detta arbetsutrymme.
2. pg-real/RLS-testfilen finns men försöket stoppades av
   `ECONNREFUSED 127.0.0.1:5432`; inga PostgreSQL-testresultat påstås.
3. Mottagen baslinje innehåller två dubbla migrationsversioner:
   `20260629120000` och `20260704120000`. De gamla migrationerna har inte
   namnändrats eftersom applicerade migrationsfiler är immutabla.
4. Betalning av migrerade AR/AP-poster har datamodell och dublettskydd men
   saknar ännu en samlad produktionsroute som både länkar och vid behov bokar
   betalningen atomiskt.
5. Historiska banktabeller och manuell verifiering finns, men import av ett
   äldre kontoutdrag till radnivå kräver fortsatt parser-/UI-arbete.
6. Bolagsverket-snapshot kan användas via befintlig registerintegration, men
   den nya bokslutsytan väljer i denna leverans profilfält och låser dem; ett
   fullständigt fält-för-fält merge-UI mot registerkällan återstår.
7. Produktionsbygget behöver nätåtkomst till Google Fonts. Själva bygget
   passerade med build-only mocks, men en omockad körning i sandlådan fick
   HTTP 502 från `fonts.gstatic.com`.

Punkt 1–3 och 7 är miljö-/baslinjeförhållanden. Punkt 4–6 är uttryckligt kvarvarande
produktarbete och ska inte betraktas som färdigverifierat.

## Tillägg 2026-07-30

8. Migration `20260730170000_canonical_year_end_staging_preview_execute.sql`
   är parser- och build-verifierad men inte applicerad mot en riktig databas i
   arbetsmiljön; `SUPABASE_DB_URL`/`DATABASE_URL` saknas.
9. De nya pg-real-scenarierna för preview-staleness, rollback och samtidighet
   behöver köras mot den migrerade testdatabasen innan produktionsaktivering.

## Slutförandereparation 2026-07-30

10. Migration `20260730213000_canonical_year_end_completion_repair.sql` är
    syntax-, ordnings-, unit- och buildverifierad men inte applicerad mot en
    riktig databas här eftersom `SUPABASE_DB_URL`/`DATABASE_URL` saknas.
11. Processorerna för återföring och outbox behöver köras i pg-real mot
    migration 423 före produktionsaktivering för att verifiera låsning,
    samtidighet, backoff och dead-letter i den faktiska PostgreSQL-versionen.

## Exekveringskontrakt 2026-07-31

12. `npm run db:migrate:status` stoppas eftersom varken `SUPABASE_DB_URL` eller
    `DATABASE_URL` finns i arbetsmiljön. Migration 424 är därför inte applicerad
    mot vare sig ren eller befintlig databas här.
13. `npm run test:pg` försöktes och stoppades av
    `ECONNREFUSED 127.0.0.1:5432`/`::1:5432`; de 75 pg-real-filerna, inklusive
    det utökade bokslutstestet, är inte godkända i detta pass.
14. `npm run build` och `npm run check:feature-policy` kan inte starta `tsx` i
    sandlådan (`listen EPERM /tmp/tsx-0/*.pipe`). Samma generatorer/kontroll
    kördes med `node --import tsx`; därefter passerade både feature-policy och
    det fullständiga Next-bygget. Detta är en runnerbegränsning, inte ett
    identifierat källkodsfel.
