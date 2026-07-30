# Ändrade och tillagda filer

Ziparkivet innehåller endast filer som skiljer sig från den mottagna
baslinjen. Huvudgrupper:

- API och wizard för periodisering, avskrivning, disposition, preview, execute
  och resultat.
- Bokslutstjänst, stagingtjänst, typer och strukturerade fel.
- iXBRL- och Bolagsverket-koppling utan klientstyrd utdelning.
- Forward-only migration
  `20260730170000_canonical_year_end_staging_preview_execute.sql`.
- Regressionstest samt projektminne och leveransdokumentation.

Den fullständiga maskinläsbara diffen finns i
`nordklart-canonical-year-end.patch`.
