# Produktionschecklista

## 1. Backup

- Ta fysisk/logisk PostgreSQL-backup och verifiera restore i separat miljö.
- Exportera migrationshistorik, funktionsdefinitioner, grants och RLS-policyer.
- Exportera read-only discrepancy views före förändring.

## 2. Write freeze

Lägg en kort write freeze på betalningar, bankmatchning, verifikationer och bokslut medan migrationen appliceras och verifieringsqueries körs. Läsning kan fortsätta om plattformens maintenance-läge stöder detta.

## 3. Förkontroller

```bash
npm ci
npm run check:guards
npm run typecheck
npm run lint
npm test
npm run build
npm run db:migrate:status
npm run check:migrations:db
```

Kör även discrepancy-rapporten:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/diagnostics/financial-subledger-discrepancies.sql
```

Stoppa om:

- samma banktransaktion redan är länkad i både AR och AP;
- idempotency-nycklar har dubbletter;
- committed/posted entries är `cancelled` utan formell reversal;
- migrationskollisionernas verkliga miljöstatus är okänd.

## 4. Migration

Applicera framåtriktat i versionsordning. Migration `20260801140000` är forward-only ur bokföringsperspektiv. Radera eller backa inte ekonomiska rader som rollbackstrategi.

## 5. Verifieringsqueries efter migration

Verifiera:

- nya funktioners signaturer;
- fast `search_path` på samtliga nya `SECURITY DEFINER`-funktioner;
- `authenticated` saknar execute på service-only-RPC:er;
- triggers för bankallokering och journal-immutabilitet är aktiva;
- discrepancy views är tomma eller har dokumenterade review-fall;
- Stripe refund/event-tabeller och index finns.

## 6. Aktivering

Driftsätt serverkoden först när migrationen är applicerad. De nya routes kräver RPC:erna och får inte rullas ut före databasen.

## 7. Avstängning av legacy writes

- Kontrollera via logg/metrics att mark-paid och bankmatchning använder de kanoniska tjänsterna.
- Blockera äldre klientversioner som fortfarande försöker skriva direkt till betalningstabeller.
- Behåll RLS/grants minimala; betalnings-RPC:erna ska vara `service_role`-only.

## 8. Övervakning

Bevaka minst:

- felkoder `IDEMPOTENCY_KEY_REUSE`, `BANK_TRANSACTION_ALREADY_ALLOCATED`, `PERIOD_LOCKED`;
- pending/failed `financial_outbox_events`;
- webhook retries och okända Stripe purchase events;
- discrepancy views;
- failed year-end runs per request-ID;
- ovanligt många reversal-/repair-runs.

## 9. Säker applikationsrollback

Vid applikationsfel: rulla tillbaka serverdeploymenten, men behåll databasmigrationens additiva objekt. Den gamla applikationen får inte återaktivera write-paths som bryter den nya immutabilitetsregeln.

## 10. Varför destruktiv SQL-rollback inte ska användas

Bokföringsdata ska rättas med framåtriktade migrationer, formella reversal entries och auditerade repair-runs. Att ta bort betalningsrader, verifikationer eller audit/outbox i en generell rollback förstör spårbarhet och kan skapa nya avvikelser mellan huvudbok, reskontra, bank och rapportversioner.
