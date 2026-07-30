# Implementationsrapport

Leveransen inför en kanonisk bokslutskedja:

1. Bokslutsjusteringar sparas som staging och skapar inga verifikationer.
2. Preview sparas med ID och hash för huvudbok, readiness, justeringar och
   regelverk.
3. Execute accepterar endast den exakta, aktuella previewn.
4. Justeringar, periodstängning och ingående balans genomförs atomiskt i samma
   PostgreSQL-transaktion.
5. Resultat och bekräftelse kan återläsas efter stängning.

Även iXBRL-flödet har låsts till serverns godkända resultatdisposition och det
tidigare breda SIE-undantaget har ersatts med en exakt evidensmatchning.

Se `TEST_RESULTS.md`, `MIGRATION_ORDER.md` och `KNOWN_LIMITATIONS.md`.
