# Aktuellt läge

Datum: 2026-07-29.

Implementerat i aktuellt arbetspass:

- Kanonisk manuell likvidkontoavstämning för SIE-/engångsbokslut utan
  bankkoppling.
- Serverberäknat huvudbokssaldo, exakt nollkrav och oföränderligt
  dokumentunderlag med SHA-256.
- Append-only historik och audit samt automatisk ogiltigförklaring när
  huvudboken ändras.
- Samma `year_end_db_blockers` används av readiness och den atomiska
  bokslutstransaktionen.
- Readinesslänken öppnar en verklig bolags- och periodbunden avstämningsvy.
- Bolagskontext och engångsbokslutsåtkomst följer periodiseringar,
  avskrivningar, dispositioner, EF/NE, årsredovisning och stängning.
- NE-länken använder routekontraktets `period_id`.

Verifierat i aktuell källkod:

- TypeScript: 0 fel.
- Riktade tester: 34 av 34 passerar.
- Vitest unit-projekt i `Europe/Stockholm`: 484 filer passerar, 1 skip;
  6 098 tester passerar, 2 skip.
- ESLint: 0 fel, 226 befintliga varningar.
- Lintbaseline: 0 nya fel.
- Antipattern-guard: passerar med 167 rå-auth-routes och 653
  avrundningsträffar.
- Featurepolicy: 461 routefiler och 292 operationer täckta.
- PostgreSQL-parser: migrationens 43 satser accepteras.
- Produktionsbygge: passerar, 354 sidor genererade.

Live-DB, migrationsstatus, pg-real och RLS-verifiering är fortfarande externa
enligt `open-blockers.md`.
