# Implementationsrapport – produktionshärdning 2026-08-01

## Leveransstatus

Den här leveransen implementerar en kritisk härdningspatch för atomiska kund- och leverantörsbetalningar, bankmatchning, verifikationsimmutabilitet, Stripe-livscykel, periodbunden bokslutsåtkomst, migreringsintegritet, felkontrakt och discrepancy/repair-stöd.

Den omfattande masterprompten är större än denna verifierade patch. Följande är därför uttryckligen inte slutbevisat eller färdigimplementerat: atomisk leverantörsfakturaregistrering/kreditkedja, full historisk AR/AP-settlement, historisk bankkontoutdragsimport, full moms/periodisering/tillgångsmatris och komplett fresh-install/upgrade/pg-real-verifiering.

## Grundfel och rotorsaker

1. **Delvis genomförda betalningar.** Verifikation, reskontrarad, fakturastatus och banklänk skrevs i olika anrop. Fel efter första skrivningen kunde lämna ekonomiskt partial state.
2. **Osäker kompensation.** Race-fall försökte ibland göra en bokförd verifikation `cancelled` i stället för att använda formell reversal.
3. **Otillräcklig idempotens.** Samma request kunde skapa ny ekonomisk effekt efter timeout/retry eller ge otydlig konflikt vid ändrad payload.
4. **Banktransaktion kunde allokeras oförenligt.** Skyddet var utspritt mellan applikationskontroller och separata tabeller.
5. **Stripe-event antogs i praktiken vara enkla/ordnade.** Async success/failure, refund updates, full refund och disputes saknade en samlad lokal state machine.
6. **Bokslutsåtkomst hade flera sanningar.** TypeScript-kod kombinerade feature grants och köp separat i stället för en exakt periodbunden databasresolver.
7. **Råa databasorsaker kunde nå klienten.** Felkontrakt och readiness var inte konsekvent sanerade.
8. **Migrationskedjan saknade manifest och hård guard.** Två äldre timestamp-kollisioner kunde inte säkert bedömas utan hash och miljöjämförelse.

## Implementerad lösning

### Atomisk kundbetalning

- Ny service-role-only RPC `settle_customer_invoice`.
- Låsning av idempotency operation, faktura och eventuell banktransaktion.
- Payload-hash och stabilt replay-resultat.
- Posting av staged draft, betalningsallokering, fakturabalans, kundkredit, banklänk, audit och outbox sker i samma PostgreSQL-transaktion.
- Samma tjänst används av intern mark-paid, v1 mark-paid, intern bankmatchning, v1 bankmatchning och pending-operation-flödet.
- Partial state returneras inte som success.

### Atomisk leverantörsbetalning

- Ny service-role-only RPC `settle_supplier_invoice`.
- Samma transaktionsgräns för posting, betalningsrad, fakturabalans, banklänk, audit och outbox.
- Samma tjänst används av samtliga fyra mark-paid/bankmatchningsytor.
- Överbetalning och osäkra cash/FX-kombinationer blockeras explicit.

### Verifikationsimmutabilitet

- Triggern tillåter endast `draft → posted`, `draft → cancelled` och `posted → reversed`.
- `posted → cancelled` blockeras.
- Bokförda ekonomiska fält och rader skyddas.
- Read-only view inventerar committed/cancelled-fall för manuell klassificering.

### Bankallokering

- Unika index skapas endast om befintliga data är rena.
- Triggern låser banktransaktionen och kontrollerar både kund- och leverantörsbetalningstabellen.
- View `bank_payment_allocation_discrepancies_v1` visar cross-ledger/dubbelallokeringar.

### Stripe-engångsköp

- Lokal eventapplikation deduplikerar på Stripe event-ID.
- Checkout, PaymentIntent, Charge, refund-ID, belopp, status, access-revocation och eventtid lagras/synkas.
- Async success ger access först när betalningen är bekräftad.
- Async failure ger inte access.
- Refunds lagras per refund-ID och endast lyckade refunds summeras.
- Full refund återkallar access; partial refund behåller access enligt explicit policy.
- Dispute-state och out-of-order event hanteras lokalt.
- Saknad lokal purchase för refund/dispute returnerar retrybart fel i stället för att eventet markeras behandlat.

### Periodbunden bokslutscapability

- Ny service-only resolver `resolve_year_end_period_capability_for_user(user, company, fiscal_period, require_write)`.
- Resolvern kombinerar company access, write access, abonnemangsfeature, exakt aktivt/betalt/ej återkallat engångsköp och plattformsbypass.
- `lib/year-end/access.ts` använder resolvern när actor och period är kända.
- Fel period eller företag nekas.

### Felmodell

Det kanoniska svaret innehåller nu bakåtkompatibelt:

- `code`
- svensk `message`
- `request_id`
- `retryable`
- `blocking`
- `http_status`
- valfri `action_url`, metadata, idempotency key och recovery flag

Rå PostgreSQL-text, schema-/tabell-/kolumn-/constraintdetaljer filtreras från klienten. Serverloggen behåller teknisk orsak.

### Discrepancy och repair

Nya read-only views:

- `customer_subledger_discrepancies_v1`
- `supplier_subledger_discrepancies_v1`
- `bank_payment_allocation_discrepancies_v1`
- `cancelled_committed_journal_entry_inventory`

Repair-RPC:n stödjer dry-run/apply, repair run-ID, before/after, actor, reason, audit och savepoint så att en misslyckad ekonomisk repair rullas tillbaka men själva failed run-recorden kan bevaras.

## Viktig teknisk avgränsning

Betalningstjänsterna skapar först en balanserad **draft** med service client och låter därefter den atomiska RPC:n posta draften och genomföra hela settlementen. En misslyckad RPC lämnar högst en icke-bokförd draft som städas till `cancelled`; den lämnar ingen huvudbokseffekt. Detta är väsentligt säkrare än tidigare flöde, men striktaste möjliga design vore att även skapa draft/rader inuti samma RPC. Det kvarstår som en framtida förstärkning och ska inte döljas.

## Migrering `20260801140000`

### Tabeller

- `financial_operation_idempotency`
- `financial_outbox_events`
- `stripe_one_time_refunds`
- `stripe_one_time_event_applications`
- `financial_repair_runs`

### Funktioner

- `enforce_single_bank_payment_allocation`
- `enforce_journal_entry_immutability`
- `get_financial_operation_result`
- `settle_customer_invoice`
- `settle_supplier_invoice`
- `stripe_apply_one_time_purchase_event`
- `resolve_year_end_period_capability_for_user`
- `run_financial_subledger_repair`

### Views

- `cancelled_committed_journal_entry_inventory`
- `customer_subledger_discrepancies_v1`
- `supplier_subledger_discrepancies_v1`
- `bank_payment_allocation_discrepancies_v1`

### Säkerhet

- Ekonomiska RPC:er är återkallade från `PUBLIC`, `anon`, `authenticated` och givna endast till `service_role`.
- `SECURITY DEFINER` använder fast `search_path`.
- Views är service-role-only.
- Migrationen är forward-only för ekonomisk integritet.

## Ändrade och nya filer

- `MIGRATION_ORDER.md` – genererad kanonisk migrationsordning och kollisionsmarkering.
- `package.json` – nya migrations-/finansguards i `check:guards`.
- `types/index.ts` – betalningsfält och separat payment journal-entry-reference.
- `supabase/migrations/20260801140000_production_financial_atomicity_and_billing_lifecycle.sql` – hela databaspatchen.
- `supabase/migrations/manifest.sha256.json` – SHA-256-manifest för 426 migrationer.
- `scripts/checks/migration-integrity.mjs` – katalog/manifest/databas-guard.
- `scripts/checks/financial-hardening-contract.mjs` – statisk ekonomisk kontraktsguard.
- `scripts/diagnostics/financial-subledger-discrepancies.sql` – read-only dry-run-rapport.
- `scripts/repairs/financial-subledger-repair.sql` – auditerad dry-run/apply-wrapper.
- `lib/bookkeeping/invoice-entries.ts` – draft-only stöd och korrekt FX-differens även vid delbetalning.
- `lib/bookkeeping/supplier-invoice-entries.ts` – draft-only stöd för leverantörsbetalning.
- `lib/invoices/mark-paid-service.ts` – kundsettlement via idempotent DB-RPC.
- `lib/supplier-invoices/mark-paid-service.ts` – leverantörssettlement via idempotent DB-RPC.
- `app/api/invoices/[id]/mark-paid/route.ts` – tunn adapter mot kundsettlement.
- `app/api/v1/companies/[companyId]/invoices/[id]/mark-paid/route.ts` – v1-adapter mot samma settlement.
- `app/api/supplier-invoices/[id]/mark-paid/route.ts` – tunn adapter mot leverantörssettlement.
- `app/api/v1/companies/[companyId]/supplier-invoices/[id]/mark-paid/route.ts` – v1-adapter mot samma settlement.
- `app/api/transactions/[id]/match-invoice/route.ts` – intern bankmatchning atomiserad; ingen implicit reversal.
- `app/api/v1/companies/[companyId]/transactions/[id]/match-invoice/route.ts` – v1-bankmatchning atomiserad.
- `app/api/transactions/[id]/match-supplier-invoice/route.ts` – intern leverantörsbankmatchning atomiserad.
- `app/api/v1/companies/[companyId]/transactions/[id]/match-supplier-invoice/route.ts` – v1-leverantörsbankmatchning atomiserad.
- `lib/pending-operations/commit.ts` – pending customer match använder kanonisk settlement.
- `app/api/stripe/webhook/route.ts` – async/refund/dispute state machine och retrybeteende.
- `lib/year-end/access.ts` – periodbunden canonical resolver.
- `lib/year-end/__tests__/access.test.ts` – resolverkontrakt.
- `lib/core/bookkeeping/year-end-service.ts` – säkrare domänfel/request-ID-propagation.
- `lib/year-end/execution-error.ts` – kända year-end-fel bevaras i stället för `YE_UNKNOWN`.
- `app/api/bookkeeping/fiscal-periods/[id]/bokslut-readiness/route.ts` – sanerat readiness-fel.
- `lib/bokslut/readiness-aggregator.ts` – rå DB-text exponeras inte.
- `lib/errors/get-structured-error.ts` – kanoniskt och sanerat felkontrakt.
- `lib/errors/structured-errors.ts` – nya stabila domänfel.
- `lib/invoices/__tests__/mark-paid-service.test.ts` – replay/rollback/atomicitetskontrakt.
- `lib/supplier-invoices/__tests__/mark-paid-service.test.ts` – leverantörsreplay/rollback.
- `lib/core/bookkeeping/__tests__/financial-atomicity.pg.test.ts` – pg-real atomicitet, grants, immutabilitet och idempotens.
- `lib/core/bookkeeping/__tests__/financial-hardening-migration.test.ts` – statiskt migrationskontrakt.
- `app/api/v1/companies/[companyId]/transactions/[id]/__tests__/route.test.ts` – v1 bankroute-mockar de kanoniska tjänsterna.
- `docs/production-hardening/*` – inventering, migration, verifiering, checklista och rapport.

## Kvarvarande arbete före definition of done

1. Installera beroenden från fungerande registry och kör full typ/lint/unit/build.
2. Kör migrationen på tom PostgreSQL och produktionslik snapshot.
3. Kör pg-real, RLS, concurrency och failure injection med separata sessioner.
4. Implementera atomisk leverantörsfakturaregistrering, kreditnota och kreditallokering.
5. Implementera full historisk AR/AP-settlement och historical bank statement import.
6. Atomisera eller uttryckligen blockera kvarvarande specialverktyg som direkt reparerar/länkar betalningsrader.
7. Kör full moms-, periodiserings-, tillgångs-, year-end- och årsredovisningsmatris.
8. Klassificera befintliga `cancelled` committed entries och subledger discrepancies före repair.
