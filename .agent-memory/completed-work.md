# Slutfört arbete

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
