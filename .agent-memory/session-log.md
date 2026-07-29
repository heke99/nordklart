# Sessionslogg

## 2026-07-29

- Packade upp projektarkivet i en orörd baslinje och en arbetskopia.
- Läste projektregler, aktuell accessmodell och senaste blocker-/stängnings-RPC.
- Implementerade manuell likvidkontoavstämning med revisionsbevarande data,
  serverberäknat saldo, dokumentunderlag, idempotens och audit.
- Kopplade readiness och atomisk stängning till samma kanoniska status.
- Lade automatisk invalidation för postade verifikationer och ändrade,
  borttagna eller tillagda verifikationsrader.
- Byggde bolags- och periodbunden API/UI samt säker evidensnedladdning.
- Propagerade `company_id` genom bokslut, periodisering, dispositioner,
  avskrivningar, EF/NE och årsredovisning.
- Korrigerade NE-routeparametern.
- Installerade låsta npm-beroenden med separat skrivbar cache.
- Körde typecheck, 34 riktade tester, hela unit-sviten, lint, lintbaseline,
  guards och featurepolicy.
- Parservaliderade migrationen med PostgreSQLs `libpg_query`.
- Körde fullständigt Next 16-produktionsbygge med 354 genererade sidor.
- Dokumenterade att pg-real/RLS och live migration kräver extern databas.
