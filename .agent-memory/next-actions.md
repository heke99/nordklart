# Nästa exakta åtgärder

1. Säkerhetskopiera mål-DB och sätt `SUPABASE_DB_URL`.
2. Lös de två befintliga dubbla migrationsversionerna mot faktisk
   migrationshistorik innan `db push`.
3. Applicera migrationerna i ordningen `20260729160000`,
   `20260729161000`, `20260729162000`.
4. Kör pg-real-testet och hela `npm run test:pg`.
5. Smoke-testa SIE parse→execute med matchande och avvikande organisationsnummer.
6. Verifiera acceptansbeloppen 11 250,00 kr, 13 595,31 kr och 13 792,50 kr i
   en separat kopia av produktionsdata.
7. Implementera den kvarvarande atomiska betalningsrouten och historiska
   bankradimporten innan de funktionerna aktiveras för slutanvändare.
