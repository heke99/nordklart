# Bokslutsfix: `open_amount` är tvetydig

Den här patchen rättar PostgreSQL-felet:

```text
column reference "open_amount" is ambiguous
```

Felet finns i `public.historical_open_items_at(uuid, date)`. Funktionen är en
PL/pgSQL `RETURNS TABLE`-funktion, vilket gör returkolumnerna till PL/pgSQL-
variabler. Slutfrågan använde `open_amount`, `source_type` och `source_id` utan
tabellalias. PostgreSQL stoppade därför bokslutsberedskapen med SQLSTATE 42702.

Migrationen kvalificerar alla kolumner utan att ändra beräkningen av kund- eller
leverantörsreskontran. Ett PG-regressionstest säkerställer att både funktionen
och `year_end_db_blockers()` kan köras.
