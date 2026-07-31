# Slutfört arbete

## 2026-07-30 — kanoniska historiska bokslutsunderlag

- Införde en unik, tenant- och periodbunden workpaper-modell ovanpå befintlig
  SIE-huvudbok och historiska stödregister.
- Införde nullable semantik för saknat stödregister och separerade bekräftelse
  från faktisk bokföringsdifferens.
- Införde automatisk refresh/backfill från slutförd SIE-import och explicit
  källhierarki.
- Införde append-only händelser, audit, återimportskonflikt och atomär
  massbekräftelse utan journalverifikation.
- Synkroniserade starkare interna/externa bevis till workpaper efter
  evidensflödet.
- Införde serverförslag för resultatdisposition och bredare explicit
  kontrollkontomappning.
- Samordnade API, readiness och historikvyn med samma status, källa, belopp och
  fokusroute.
- Delade UI i klart, bekräftelse och verkliga fel och lade till selektiv
  massbekräftelse.
- Lade diagnostik, teknisk dokumentation, unit- och pg-real-regressionstester.
- Verifierade typecheck, lint, guards, 6 112 unit-tester, PostgreSQL-parsning,
  migrationsordning och Next-produktionsbygge.

## 2026-07-29 — SIE och historiska bokslutsunderlag

- Etablerade en checksummad baslinje från mottaget projektarkiv.
- Samordnade filgräns, statusmodell, juridisk identitet och parse/execute.
- Införde beständig parse-session och oförändrat SIE-original.
- Införde korrigeringsproveniens för kontomappningar.
- Byggde separata historiska stödregister utan faktura- eller journalbiverkan.
- Införde serverberäknad AR/AP-, bank-, EK-, skatt- och momsavstämning.
- Införde dokumentbevis, idempotens, append-only-historik och invalidation.
- Införde gemensamma explicit konfigurerade kontrollkonton.
- Byggde tenant- och periodbundet API/UI för bokslutsunderlag.
- Införde företagssnapshot, strukturerad resultatdisposition/utdelning och
  synlighetsstyrda anteckningar.
- Kopplade samma kontrollkontrakt till readiness och atomisk stängning.
- Kopplade resultatöverföringen till produktionsflödet.
- Rättade årsredovisningens utdelningsheuristik och fryste juridisk identitet.
- Uppdaterade AR-rapporten till gemensam kontrollkontokonfiguration.
- Lade unit- och pg-real-regressionstester.
- Verifierade unit, typecheck, lint, guards och Next-produktionsbygge.

## 2026-07-29 — tidigare pass

- Införde manuell serververifierad likvidkontoavstämning med dokument,
  invalidation och samma bokslutsblockerare.

## 2026-07-30 — staging, beständig preview och atomisk execute

- Ersatte direktbokning från periodisering, avskrivning och disposition med
  tenant- och periodbunden staging.
- Införde versionsstyrda skatteregler, beständig preview och fyra snapshots.
- Band execute till preview-ID och lade justeringsbokning, stängning, IB,
  reverseringsschema, run-resultat och outbox i en transaktion.
- Gjorde dispositionsbatchen odelbar och tog bort klientstyrda skattesatser.
- Rättade det breda SIE-undantaget till exakt workpaper-/import-/ledger-match.
- Tog bort query- och UI-styrd utdelning från iXBRL/Bolagsverket.
- Lade återöppningsbart slutresultat och beständig granskningsbekräftelse.
- Lade regressionstest för staged preview utan journalföring.
- Verifierade typecheck, 6 114 unit-tester, lint, guards, PostgreSQL-parser och
  Next-produktionsbygge.

## 2026-07-30 — bokslutets slutförandereparation

- Samlade bokslutets kalkylatorer och rapportunderlag på samma projicerade
  huvudbok.
- Införde tom gruppersättning och gemensamma strukturerade API-fel.
- Separade justeringskällor från den reserverade slutstängningen och gjorde
  idempotensåterspelning oberoende av preview-status.
- Implementerade fungerande retry/dead-letter-processorer för återföringar och
  outbox, inklusive korrekt återföring av handlerfel.
- Samordnade v1-rutt och bakgrundskö med genomfört-resultat-med-varning.
- Rättade periodbunden rapportåtkomst, rollåtkomst och hårdkodade skatteregler.
- Verifierade 6 120 unit-tester, typecheck, lint, guards, feature-policy,
  PostgreSQL-syntax och Next-produktionsbygge.

## 2026-07-31 — bokslutets exekveringskontrakt

- Rättade kollisionen mellan generisk `year_end` och det enda kanoniska
  `year_end_closing`-verifikatet med forward-only migration och legacy-guard.
- Synkroniserade source types mellan DB, Zod, TypeScript, etiketter och SIE.
- Införde typade fel utan message-regex, svenska säkra meddelanden, riktiga
  HTTP-statusar och beständig correlation/retry/recovery-data.
- Låste staging, preview, execute och acknowledgement till `service_role` och
  flyttade alla tre staging-routes till verifierade serveranrop.
- Införde stabil klientnyckel, scope-hashad idempotens, advisory lock,
  återläsning efter osäkert svar och strikt Zod-validering av RPC-resultatet.
- Rättade exakt nästa period, återanvändning av korrekt IB, konfliktfall,
  resultatnollställning, UB–IB-kontinuitet, statusövergångar, audit och outbox.
- Lade pg-real-scenario med disposition, skatt och periodisering tillsammans,
  IB-återanvändning, datumglapp och RPC-rättigheter samt nya unit-tester.
- Verifierade lokalt typecheck, 6 128 unit-tester, lint, guards,
  feature-policy, PostgreSQL-syntax och produktionsbygge.
