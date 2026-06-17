# Nordklart — kör 347 originalmigrationer säkert utan Docker

Det här projektet använder originalmigrationerna i:

```text
supabase/migrations/
```

Det ska **inte** blandas med `supabase/migrations_clean_start/` om du väljer originalspåret.


## Antal migrationer

Den senaste uppladdade `nordklart-main.zip` innehöll 345 migrationer i `supabase/migrations/`.

De två migrationerna från den tidigare Accounted-porten saknades i den zippen, så den här patchen lägger även tillbaka:

```text
20260624120000_nordklart_articles_accruals_ixbrl_foundation.sql
20260624121000_nordklart_products_entitlements_year_end_bankgiro_api.sql
```

Efter denna patch finns därför 347 migrationer i `supabase/migrations/`.

## Viktig status i din databas

Du körde migrationerna manuellt via Supabase SQL Editor/copy-paste.

Sista lyckade migrationen du angav var:

```text
20260324120001_skatteverket_tokens.sql
```

I den uppladdade zippen är den filen **nummer 74**, inte 73.

Det betyder att nästa migration ska vara:

```text
#75 20260324120002_categorization_templates_line_pattern.sql
```

Jag har verifierat att zip-ordningen och filnamnsordningen är samma i den uppladdade zippen, så CLI:n kan sortera efter filnamn och ändå följa rätt ordning.

## Databas-URL

Lägg detta i `.env.local` lokalt:

```env
SUPABASE_DB_URL="postgresql://postgres.xxxxx:DITT_LÖSENORD@aws-...pooler.supabase.com:5432/postgres"
```

Rekommendation: använd Supabase **Session pooler** eller **Direct connection**. Undvik Transaction pooler för stora schema-migrationer om Supabase erbjuder båda.

Skicka aldrig lösenordet till ChatGPT.

## Kommandon

### 1. Kontrollera ordningen runt sista körda migration

```bash
npm run db:migrate:plan-after -- 20260324120001_skatteverket_tokens.sql
```

Förväntat:

```text
Last applied: #74 20260324120001_skatteverket_tokens.sql
Next migration: 20260324120002_categorization_templates_line_pattern.sql
Remaining migrations: 273
```

### 2. Markera redan manuellt körda migrationer

Detta kör inte SQL för de första 74 filerna. Det skapar bara en logg i databasen så runnern inte kör om dem.

```bash
npm run db:migrate:mark-through -- 20260324120001_skatteverket_tokens.sql
```

### 3. Kontrollera status

```bash
npm run db:migrate:status
```

Förväntat:

```text
Total files: 347
Logged as applied: 74
Next migration: #75 20260324120002_categorization_templates_line_pattern.sql
```

### 4. Kör resten

```bash
npm run db:migrate
```

Runnern kör migration 75–347 en och en i ordning.

## Om något failar

Gör inte copy/paste vidare manuellt.

1. Läs felmeddelandet.
2. Fixa migrationen eller databasläget.
3. Kör igen:

```bash
npm run db:migrate
```

Runnern hoppar över allt som redan är loggat och fortsätter från första ej körda migration.

## Intern loggtabell

Runnern skapar:

```sql
public.nordklart_schema_migrations
```

Den innehåller:

```text
version
checksum
source
applied_at
```

Det här är separat från Supabase CLI:s egna tabell `supabase_migrations.schema_migrations`, eftersom du redan började via SQL Editor/copy-paste.

## Varför inte Supabase CLI här?

Eftersom de första migrationerna redan kördes manuellt kan Supabase CLI:s historik vara tom eller osynkad. Då riskerar `supabase db push` att försöka köra om gamla migrationer.

Denna runner löser det genom att markera exakt de manuellt körda migrationerna och fortsätta från nästa fil.
