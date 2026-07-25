# Databas och migrationer

- Den mottagna baslinjen innehåller 415 migrationer.
- Migrationer är framåtriktade, idempotenta där det är praktiskt och får inte
  redigera redan driftsatt historik.
- Schema, constraints, index, funktioner, triggers, grants och RLS ska levereras
  tillsammans när en databasförändring kräver det.
- SQL-kod ska kvalificera tvetydiga kolumner. Den senaste korrigeringen för
  historiska öppna poster kvalificerar `open_amount` i CTE:er och slutresultat.
- Migrationerna för kompletterande Full Access, auktoritativ feature-resolver
  och `open_amount` måste finnas och vara applicerade i målmiljön:
  `20260722224500`, `20260722233000`, `20260723001500`.

Live-migrationsstatus kunde inte verifieras i den isolerade arbetsmiljön eftersom
ingen mål-DB eller lokal PostgreSQL/Docker fanns tillgänglig.

