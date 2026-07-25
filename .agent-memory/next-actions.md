# Nästa exakta åtgärder

1. Kör `supabase migration list`/projektets migrationsstatus mot målmiljön och
   applicera saknade migrationer.
2. Kör pg-real-, RLS- och tenantisoleringstester mot en separat testdatabas.
3. Migrera de högst riskklassade finansiella routes som använder rå auth till
   `requireAuth`/kanonisk wrapper; lägg negativa MFA/RBAC-tester.
4. Kör guarden och sänk `raw-route-auth`-baslinjen endast med faktiskt borttagna
   träffar.
5. Klassificera avrundningsträffar med bokföring, moms, lön och betalning först;
   ersätt ekonomiska fall med `roundOre()` och regressionstesta gränsvärden.
6. Granska de två migration/RLS-träffarna mot live-schema och eliminera dem.

