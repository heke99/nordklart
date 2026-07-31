# Migrationsordning

Alla befintliga migrationer ska först vara applicerade i filnamnsordning.
För den kanoniska bokslutskedjan måste följande tre migrationer därefter finnas
i exakt denna ordning:

```text
supabase/migrations/20260730170000_canonical_year_end_staging_preview_execute.sql
supabase/migrations/20260730213000_canonical_year_end_completion_repair.sql
supabase/migrations/20260731120000_year_end_execution_contract_repair.sql
```

Den sista migrationen är forward-only och:

- skapar ett unikt index enbart för `year_end_closing`;
- behåller äldre bokförda `year_end`-rader oförändrade;
- separerar alla bokslutsjusteringars `source_type`;
- låser ekonomiskt förändrande RPC:er till `service_role`;
- synkroniserar `year_end_runs` med API-kontraktet;
- ersätter period-/IB-kärnan med strikt periodkontinuitet och verifierad återanvändning av befintlig IB;
- returnerar det faktiska utfallet för nästa period och ingående balans.

Ta alltid en databasbackup och kör först i staging.

## Kontrollera migrationsstatus

```sql
select version
from supabase_migrations.schema_migrations
where version in (
  '20260730170000',
  '20260730213000',
  '20260731120000'
)
order by version;
```

Alla tre rader ska returneras i ordningen ovan.

## Applicera

```bash
npm run db:migrate:status
npm run db:migrate
npm run db:migrate:status
```

## Verifiera databaskontraktet

```sql
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'journal_entries'
  and indexname like 'journal_entries_one_year_end%'
order by indexname;

select to_regprocedure(
  'public.execute_year_end_closing(uuid,uuid,uuid,text,jsonb,uuid,text)'
) as execute_rpc;

select
  has_function_privilege(
    'authenticated',
    'public.execute_year_end_closing(uuid,uuid,uuid,text,jsonb,uuid,text)',
    'EXECUTE'
  ) as authenticated_can_execute,
  has_function_privilege(
    'service_role',
    'public.execute_year_end_closing(uuid,uuid,uuid,text,jsonb,uuid,text)',
    'EXECUTE'
  ) as service_role_can_execute;

select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'year_end_runs'
  and column_name in (
    'status', 'current_step', 'error_code', 'error_message',
    'technical_error', 'user_message', 'correlation_id', 'retryable',
    'retry_count', 'recovery_required', 'idempotency_key', 'preview_id',
    'started_at', 'finished_at', 'created_at', 'updated_at',
    'next_period_id', 'next_period_created', 'closing_entry_id',
    'opening_balance_entry_id', 'opening_balance_created'
  )
order by column_name;
```

Förväntat:

- `journal_entries_one_year_end_per_period` saknas;
- `journal_entries_one_year_end_closing_per_period` finns och dess villkor är exakt `source_type = 'year_end_closing' AND status = 'posted'`;
- RPC-signaturen returneras;
- `authenticated_can_execute = false`;
- `service_role_can_execute = true`;
- samtliga efterfrågade `year_end_runs`-kolumner returneras.
