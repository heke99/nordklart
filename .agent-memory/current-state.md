# Aktuellt läge

Datum: 2026-07-30.

Implementerat i aktuellt arbetspass:

- Ett beständigt kanoniskt bokslutsunderlag per företag, år och område med
  källprioritet, SIE-proveniens, nullable differens och återimportskonflikt.
- Append-only händelsehistorik för generering, acceptans, verifiering, manuell
  justering, faktisk differens och återimportbeslut.
- Automatisk generering/backfill från senaste slutförda SIE-import för AR/AP,
  bank, moms, skatt, eget kapital, periodiseringar, anläggningar, lån och
  övriga fordringar/skulder.
- Massbekräftelse av importerade historiska saldon utan journalföring.
- Saknat stödregister visas som okänt (`NULL`) och SIE-saldo som
  `imported_from_sie`, inte som falsk nolldifferens.
- Källhierarki som bevarar verifierat externt och manuellt underlag samt kräver
  keep/replace vid en avvikande återimport.
- Gemensam sida och preflightgrupper för `Klart automatiskt`,
  `Behöver bekräftas` och `Måste åtgärdas`, med period-/företags-/fokusroute.
- Manuella ändringar klassificeras; bokföringsmässig korrigering avvisas och
  hänvisas till riktig rättelseverifikation.
- Serverberäknat resultatdispositionsförslag och utökad explicit
  kontrollkontomappning.
- En enda kanonisk SIE-statusmodell i TypeScript och PostgreSQL, inklusive
  `staged` i bokslutets blockeringskontroll.
- Organisationsnummerkontroll i parse, execute och databasfinalisering.
- WORM-arkiverad parse-session med separat SHA-256 för originalbytes och
  hashverifierad återläsning vid execute.
- Append-only korrigeringslogg för godkända kontomappningar.
- Historiska stödregister för AR/AP, bank, eget kapital, skatt och moms utan
  journalföring vid registrering.
- Gemensamma explicit konfigurerade kontrollkonton för bokslut och rapporter.
- Serverberäknade AR/AP-avstämningar, dokumentkrav, idempotens, stale-kontroll
  och SIE-invalidation.
- Låst företagssnapshot, strukturerad resultatdisposition/utdelning,
  anteckningssynlighet och årsredovisningskoppling.
- Rikare `year_end_control_status`, direkta bokslutsåtgärder och samma
  blockerfunktion inuti atomisk stängning.
- Resultatöverföring 2099→2098 sker exakt en gång eller länkas till en
  beloppsmässigt motsvarande SIE-verifikation.
- Årsredovisningen använder låst snapshot, kanonisk huvudbok, strukturerad
  disposition och endast explicit `dividend_decision` som utdelning.

Verifierat 2026-07-30:

- TypeScript: 0 fel.
- Full unit-svit: 487 filer passerar, 1 skip; 6 112 tester passerar, 2 skip.
- Riktade workpaper/readiness-tester: 16 av 16 passerar.
- ESLint för ändrade filer: 0 fel.
- Antipattern-guard: passerar och minskar naiv öresavrundning med 13 träffar.
- PostgreSQL-parser: den nya migrationens 44 statements accepteras.
- Produktionsbygge: passerar med 355 genererade sidor när blockerade externa
  fontnedladdningar ersätts med build-only mocks.
- De 419 tidigare migrationerna är orörda; endast migration 420 är ny.

Live-DB, pg-real och migrationsstatus kräver en PostgreSQL/Supabase-anslutning
och redovisas som ej körda i `open-blockers.md`.
