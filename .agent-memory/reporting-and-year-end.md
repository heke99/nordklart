# Rapportering och bokslut

- Rapporter ska härledas från bokföringens kanoniska data, inte UI-cache.
- Bokslutsåtkomst ägs av `lib/year-end/access.ts`.
- Full Access kan ge företagsövergripande bokslutsåtkomst.
- Engångsköp är knutet till exakt räkenskapsperiod och ska ge åtkomst även om den
  företagsövergripande feature-resolvern tillfälligt är nere.
- Tekniskt fel i åtkomstupplösning är `database_error`, aldrig automatiskt
  `missing_entitlement`.
- Stängning ägs av `execute_year_end_closing`; blockers av
  `year_end_db_blockers`.

