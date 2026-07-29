# Slutfört arbete

## 2026-07-29

- Etablerade en orörd baslinje från det mottagna projektarkivet.
- Ersatte den trasiga bokslutsavstämningslänken med en verklig route.
- Införde manuell serververifierad avstämning för företag utan bankdata.
- Gjorde verifiering, underlag och invalidation append-only.
- Skyddade accepterade dokumentunderlag mot ändring och borttagning.
- Lät huvudboksändringar ogiltigförklara tidigare verifieringar.
- Återanvände samma kanoniska blockerfunktion i UI och atomisk stängning.
- Propagerade vald bolagskontext genom hela boksluts- och årsredovisningsflödet.
- Säkrade periodbunden skrivåtkomst för engångsköpt bokslut utan att den
  generiska feature-/write-gaten stoppar flödet i förtid.
- Korrigerade NE-parametern från `fiscal_period_id` till `period_id`.
- Lade TypeScript-, unit-, featurepolicy- och pg-real-regressionstester.
- Verifierade typecheck, unit, lint, guards, featurepolicy, SQL-syntax och
  fullständigt Next-produktionsbygge.

## 2026-07-25

- Införde systemisk separation mellan featureavslag och databasfel.
- Propagerade bokslutsåtkomstorsak genom period- och rapport-API:er.
- Säkrade periodbundet engångsköp vid feature-resolveravbrott.
- Lade regressionstester för åtkomst- och resolverfallen.
