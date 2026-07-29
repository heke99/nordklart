# Nästa exakta åtgärder

1. Applicera
   `supabase/migrations/20260728143000_year_end_manual_cash_reconciliation.sql`
   mot en separat testdatabas.
2. Kör `npm run test:pg` och verifiera skapande, differensavslag,
   dokumentimmutabilitet, invalidation och tenantisolering.
3. Kontrollera målmiljöns migrationsstatus och applicera migrationen innan den
   nya applikationskoden driftsätts.
4. Smoke-testa ett SIE-only-bolag: ladda upp kontoutdrag, verifiera 0,00 kr,
   ändra huvudboken, kontrollera att avstämningen blir stale och verifiera på
   nytt.
5. Smoke-testa engångsbokslut för valt kundbolag genom hela guiden inklusive
   årsredovisning och NE-underlag.
6. Fortsätt minska den befintliga auth- och avrundningsskulden utan att höja
   guardbaslinjerna.
