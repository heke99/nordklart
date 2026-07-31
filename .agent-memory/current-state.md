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

## Kanonisk bokslutskedja 2026-07-30

- Periodiseringar, avskrivningar och bokslutsdispositioner sparas som
  justeringar utan journalföring.
- Preview är beständig och bunden till huvudboks-, readiness-, justerings- och
  regelverkshash.
- Execute kräver exakt preview-ID och bokför alla justeringar, stänger perioden
  samt skapar nästa periods IB i samma PostgreSQL-transaktion.
- Resultatet kan återläsas från den stängda körningen och användarens
  granskningsbekräftelse sparas serverbaserat.
- iXBRL hämtar utdelning från låst resultatdisposition och kräver en stängd
  bokslutskörning; klient- och queryparametrar styr inte utdelningen.
- SIE-undantag för AR/AP kräver exakt period, slutförd import, accepterat
  workpaper och matchande aktuell ledger-fingerprint.

Verifierat i detta pass:

- TypeScript: 0 fel.
- Full unit-svit: 487 filer passerar, 1 skip; 6 114 tester passerar, 2 skip.
- Lintbaseline och antipattern-guard: passerar.
- PostgreSQL-parser: migrationens 49 statements accepteras.
- Produktionsbygge: passerar, 355 sidor.

## Slutförandereparation 2026-07-30

- Alla bokslutsdelar läser samma projicerade huvudbok från sparade staged
  adjustments innan preview och execute.
- Tom ersättning av periodiseringar, avskrivningar och dispositioner tar bort
  den tidigare sparade gruppen i stället för att lämna kvar gamla rader.
- Bokslutsstängning använder `year_end_closing`; vanliga bokslutsjusteringar
  har separata källtyper och avskrivningsmotorn använder inte den reserverade
  stängningstypen.
- Idempotens återspelas före preview-statuskontroll.
- Återföringar och outbox har låsta, retrybara processorer med beständiga
  försök, backoff och dead-letter; handlerfel markeras inte som levererade.
- API- och köanropare hanterar ett bokfört resultat med varning utan att
  felrapportera en redan genomförd bokslutstransaktion.
- Periodbunden köprätt används för bokslutsrapporter och skrivåtkomst kan inte
  återöppnas via den gamla `client_user`-rollen.

Slutverifierat 2026-07-30:

- TypeScript: 0 fel.
- Full unit-svit: 488 filer passerar, 1 skip; 6 120 tester passerar, 2 skip.
- Lintbaseline, antipattern-guard och feature-policy: passerar.
- Feature-policy: 465 routefiler och 296 operationer täcks.
- PostgreSQL-parser: migration
  `20260730213000_canonical_year_end_completion_repair.sql` har 35 giltiga
  statements och ligger sist som migration 423.
- Produktionsbygge: passerar med 356 genererade routes/sidor.

## Exekveringskontrakt för bokslut 2026-07-31

- Slutverifikatet använder endast `year_end_closing`; partiellt unikt index
  omfattar inte längre staged dispositioner eller andra bokslutsjusteringar.
- Execute är en serverlåst, atomisk och advisory-lock-serialiserad transaktion
  med strikt preview/hash-kontroll, faktisk nästa-period/IB-status och exakt
  UB–IB-verifiering i PostgreSQL `numeric`.
- Ett befintligt korrekt IB återanvänds och länken repareras; datumglapp,
  motstridigt/flerdubbelt IB och inkonsekventa periodtillstånd stoppas med
  stabila domänfel och recovery-status där det krävs.
- `year_end_runs`, API, felregister och wizard använder samma status-,
  retry-, recovery-, correlation- och idempotenskontrakt.
- Ekonomiskt förändrande boksluts-RPC:er är `service_role`-låsta, medan varje
  serveranrop fortfarande verifierar den namngivna aktörens bolagsskrivåtkomst.
- Audit och outbox skapas i samma transaktion som den fullständiga stängningen.

Lokalt verifierat 2026-07-31: typecheck 0 fel, 6 128 unit-tester passerar,
ändrad-fil-lint 0 fel, full lint 0 fel/226 befintliga varningar, guards och
feature-policy passerar, migrationen parsas som 42 PostgreSQL-statements och
Next-produktionsbygget passerar med 356 routes/sidor. Live-migration och
pg-real är fortfarande blockerade av saknad PostgreSQL på `localhost:5432`
och saknad `SUPABASE_DB_URL`/`DATABASE_URL`.
