# Migrationsordning

Alla befintliga migrationer ska först vara applicerade i filnamnsordning.
Applicera därefter:

```text
supabase/migrations/20260730170000_canonical_year_end_staging_preview_execute.sql
```

Migrationen är forward-only och de äldre migrationsfilerna har inte ändrats.
Ta en databasbackup och kör först i staging.
