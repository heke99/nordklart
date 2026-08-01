# Migreringsreconciliation

## Nya verktyg

- `scripts/checks/migration-integrity.mjs`
- `supabase/migrations/manifest.sha256.json`
- `MIGRATION_ORDER.md`

Guardens ansvar:

1. läsa samtliga `*.sql` i `supabase/migrations`;
2. kontrollera versionsformat och sortering;
3. beräkna SHA-256 för varje fil;
4. stoppa saknade/ändrade filer mot manifestet;
5. identifiera dubbla versionsnummer;
6. tillåta endast uttryckligen dokumenterade äldre kollisioner;
7. med `--db` jämföra katalogen mot databasens migrationshistorik/checksummor.

## Säker analys per miljö

Kör först utan skrivning:

```bash
npm run check:migrations
npm run db:migrate:status
npm run check:migrations:db
```

`SUPABASE_DB_URL` eller `DATABASE_URL` måste peka på den miljö som analyseras. Kör separat mot utveckling, staging och produktion.

För varje kollision ska följande dokumenteras innan någon SQL appliceras:

- vilka av de två filernas effekter som finns i schemat;
- vilken versionsrad som finns i `supabase_migrations.schema_migrations`;
- om Nordklarts checksummelog finns och vilken hash den innehåller;
- om båda filerna har applicerats manuellt trots en gemensam version;
- vilka objekt som saknas eller avviker.

Döp inte om redan körda filer. Skapa i stället en ny framåtriktad migration med ett nytt unikt versionsnummer som idempotent återskapar saknade effekter.

## Fresh install och upgrade

Före produktion ska två isolerade databaser byggas:

1. tom databas + samtliga migrationer;
2. produktionslik äldre snapshot + endast efterföljande migrationer.

Jämför därefter minst:

- tabeller och kolumntyper;
- funktioners signaturer och `proconfig`/`search_path`;
- triggers och constraints;
- index;
- grants;
- RLS-status och policydefinitioner.

Denna jämförelse har inte kunnat köras i leveransmiljön eftersom PostgreSQL och `DATABASE_URL` saknades.
