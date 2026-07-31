# Sessionslogg

## 2026-07-29

- Läste hela målbeskrivningen, projektreglerna och befintlig bokslutsarkitektur.
- Checksummade 417 befintliga migrationer och lämnade dem orörda.
- Implementerade tre forward-only migrationer för SIE-identitet/sessioner,
  stödregister samt bokslut/årsredovisning.
- Samordnade dashboard- och v1-SIE-importen med samma identitet, storleksgräns,
  arkiv och statusmodell.
- Byggde historiskt stödregister-API och en period-/företagsbunden arbetsyta.
- Kopplade kontrollstatus, snapshot, disposition och anteckningar till
  bokslutsguiden och årsredovisningen.
- Rättade AR-kontrollkontodrift och utdelningsklassificering.
- Lade unit- och pg-real-tester.
- Installerade låsta npm-beroenden med skrivbar cache.
- Körde 6 109 unit-tester, typecheck, ändrad-fil-lint, lintbaseline, guards och
  produktionsbygge.
- Försökte köra pg-real och migrationsstatus; dokumenterade de verkliga
  miljöblockeringarna utan att markera dem som passerade.

## 2026-07-30

- Kartlade kvarvarande falska blockerare i det historiska bokslutsflödet.
- Införde kanoniska workpapers, källprioritet, append-only historik,
  återimportskonflikt, automatisk refresh och idempotent backfill.
- Samordnade status/belopp/källa mellan databas, API, readiness och UI.
- Lade massbekräftelse utan journal, klassificerad manuell justering,
  resultatdispositionsförslag och explicit kontrollkontomappning.
- Uppdaterade evidensflödet så starkare källor synkroniseras till workpaper.
- Lade diagnostik, teknisk leveransrapport och regressionstester.
- Körde 6 112 unit-tester, typecheck, ändrad-fil-lint, lintbaseline, guards,
  PostgreSQL-parser, migrationslista och produktionsbygge.
- Försökte köra pg-real; dokumenterade `ECONNREFUSED :5432` som
  miljöblockering.
- Återställde mottagen projektbaslinje och etablerade exakt lokal Git-diff.
- Kartlade direktbokning, delbatch, flyktig preview, klientstyrd utdelning och
  det breda SIE-undantaget som konkreta P0-avvikelser.
- Byggde staging → beständig preview → atomisk execute med versionsbundna
  snapshots, reverseringsschema, run-resultat och outbox.
- Samordnade API, wizard, iXBRL och Bolagsverket med den kanoniska kedjan.
- Lade serverbaserad resultatbekräftelse och återläsning av stängd körning.
- Körde typecheck, lintbaseline, guards, 6 114 unit-tester,
  PostgreSQL-parser och produktionsbygge med godkänt resultat.
- Slutförde gemensam projicerad huvudbok, tom gruppersättning, strukturerad
  API-felhantering och periodbunden rapportåtkomst.
- Lade migration 423 med separata justeringskällor, idempotensåterspelning och
  retry/dead-letter-processorer för återföring och outbox.
- Rättade processorns transaktionsgränser, handlerfel och de sista API-/kö-
  kompatibilitetsfallen.
- Slutverifierade 6 120 unit-tester, typecheck, lintbaseline, guards,
  feature-policy, 35 PostgreSQL-statements, migrationsordning och ett komplett
  produktionsbygge med 356 routes/sidor.
- Dokumenterade live-DB och pg-real som ej körda eftersom databas-URL saknas.

## 2026-07-31

- Kartlade execute-kedjan från wizard via route/service till preview, staged
  adjustments, run-tabell, final close, nästa period och IB.
- Identifierade felaktigt partiellt index, för breda RPC-grants, saknad
  `retryable`, textbaserad felklassificering, gissade RPC-resultat, första
  framtida period och blockerad återanvändning av korrekt IB.
- Implementerade migration 424, typade fel/resultat, scope-idempotens,
  statusmaskin, recovery, full audit/outbox och UI-återläsning.
- Upptäckte i andra granskningsvarvet att serverlåsta staging-RPC:er fortfarande
  anropades med användarklient i tre routes och rättade samtliga.
- Lade kombinerat pg-real-scenario för två dispositioner, skatt och
  periodisering samt regressioner för IB, datumglapp och grants.
- Körde och godkände typecheck, 6 128 unit-tester, ändrad-fil-lint, full lint,
  guards, feature-policy, PostgreSQL-parser och produktionsbygge.
- Försökte migrationsstatus och pg-real; dokumenterade saknad DB-URL och
  `ECONNREFUSED localhost:5432` utan att räkna dem som godkända.
