# Autentisering och RBAC

- Skyddade routes ska använda `requireAuth`, `withRouteContext` eller motsvarande
  kanonisk wrapper, inklusive MFA-kontroll.
- `supabase.auth.getUser()` ensamt räcker inte som routeauktorisering.
- Behörighet avgörs server-side utifrån medlemskap, roll, operation och företag.
- UI-döljning är en bekvämlighet, aldrig en säkerhetsgräns.
- Plattformsåtkomst ska vara uttrycklig och revisionsbar.

Guard-baslinjen visar fortfarande 167 routefiler med rå auth-användning. Detta är
aktiv säkerhetsskuld och ska migreras riskbaserat utan att sänka baslinjen genom
undantag.

