# Nästa exakta åtgärder

1. Säkerhetskopiera mål-DB och sätt `SUPABASE_DB_URL`.
2. Lös de två befintliga dubbla migrationsversionerna mot faktisk
   migrationshistorik innan `db push`.
3. Applicera migrationerna i ordningen `20260729160000`,
   `20260729161000`, `20260729162000`, `20260730110000`.
4. Kör `scripts/diagnostics/year-end-historical-workpapers.sql`.
5. Kör pg-real-testet och hela `npm run test:pg`.
6. Smoke-testa SIE parse→execute med matchande och avvikande organisationsnummer.
7. Testa en återimport med ändrat, tidigare accepterat saldo och båda besluten
   keep/replace.
8. Verifiera acceptansbeloppen 11 250,00 kr, 13 595,31 kr och 13 792,50 kr i
   en separat kopia av produktionsdata.
9. Implementera den kvarvarande atomiska betalningsrouten och historiska
   bankradimporten innan de funktionerna aktiveras för slutanvändare.
10. Applicera därefter
    `20260730170000_canonical_year_end_staging_preview_execute.sql`.
11. Kör `npm run test:pg` mot den migrerade testdatabasen och smoke-testa:
    staging utan journal, stale preview, samtidig execute, rollback vid fel,
    återläsning av resultat samt iXBRL från låst disposition.
12. Applicera därefter
    `20260730213000_canonical_year_end_completion_repair.sql`.
13. Kör åter `npm run test:pg` och verifiera särskilt tom gruppersättning,
    idempotent återspelning efter genomförd preview, parallella
    återföringsarbetare, outbox-retry och dead-letter.
14. Aktivera cron-anropet till `/api/bookkeeping/year-end/process/cron` först
    efter att migration 423 och pg-real-kontrollerna har passerat.
