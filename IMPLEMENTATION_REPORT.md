# Implementeringsrapport — bokslut utan bankkoppling

Datum: 2026-07-29

## Levererat

- En fungerande, bolags- och periodbunden avstämningsvy ersätter 404-länken.
- SIE-/engångsbokslut utan bankkoppling kan verifiera konto 1930 eller andra
  aktiva likvidkonton mot ett uppladdat balansdagsunderlag.
- Huvudbokssaldot beräknas i PostgreSQL. Browsern kan inte ange eller
  manipulera det beräknade saldot.
- Endast exakt 0,00 kr i differens accepteras.
- Verifieringar, invalidationer och accepterade dokumentunderlag är
  append-only och revisionsspårade.
- Efterföljande huvudboksändringar gör tidigare verifiering ogiltig.
- Readiness och den atomiska stängningstransaktionen använder samma
  `year_end_db_blockers`.
- Företagskontext och engångsbokslutsåtkomst följer hela flödet till
  periodisering, avskrivning, disposition, EF/NE och årsredovisning.
- NE-länken skickar korrekt `period_id`.

## Driftsättningsordning

1. Applicera migrationen
   `supabase/migrations/20260728143000_year_end_manual_cash_reconciliation.sql`.
2. Kör pg-real/RLS-tester mot testdatabasen.
3. Driftsätt applikationsfilerna.
4. Smoke-testa först ett SIE-only-bolag och därefter ett valt kundbolag med
   engångsbokslut.

Migrationen måste appliceras före applikationskoden eftersom API och readiness
anropar de nya databasfunktionerna.

## Verifiering

| Kontroll | Utfall |
|---|---|
| TypeScript | PASS, 0 fel |
| Riktade tester | PASS, 34/34 |
| Unit | PASS, 6 098 pass / 2 skip |
| ESLint | PASS, 0 fel / 226 befintliga varningar |
| Lintbaseline | PASS, 0 nya fel |
| Guards | PASS |
| Featurepolicy | PASS, 461 routes / 292 operationer |
| PostgreSQL-parse | PASS, 43 satser |
| Next-produktionsbygge | PASS, 354 sidor |
| pg-real/RLS | Ej kört — PostgreSQL-testdatabas saknas |
| Live migrationsstatus | Ej kontrollerad — mål-DB-anslutning saknas |
