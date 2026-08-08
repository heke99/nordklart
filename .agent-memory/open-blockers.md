# Aktiva blockerare och skuld

Uppdaterad 2026-08-07 efter remediation mot auditen 2026-08-06.

Allt nedan är verifierat i detta arbetspass. Punkter som tidigare stod som
blockerare men nu är motbevisade ligger under "Stängda antaganden".

## Blockerande före produktionsanspråk

1. **Unit-sviten: 43 av 6162 failar** (var 47). Alla i settlement-routetester:
   `transactions/[id]/match-invoice` (18), `match-supplier-invoice` (11),
   `supplier-invoices/[id]/mark-paid` (6), `v1 supplier-invoices` (3),
   `v1 invoices mark-paid` (3), `stripe/webhook` (2).

   Grundorsak: testerna modellerar bara EN Supabase-klient. Sedan
   settlement-tjänsterna började använda `createServiceClient()` för
   `settle_customer_invoice` / `settle_supplier_invoice` behöver de en separat
   service-klient med egen kö. `supabaseServerMock()` i `tests/helpers.ts`
   speglar nu modulens exportyta (det löste 54 modulladdningsfel), men varje
   test måste fortfarande köa sitt eget RPC-svar.

   **Ordningsanmärkning:** detta är exakt den kodväg H-03 (Phase 3) bygger om.
   Att laga mockarna mot nuvarande form och sedan igen efter H-03 är dubbelt
   arbete. Gör H-03 först, laga sedan dessa tester en gång mot slutlig form.

   pg-real är däremot **501/501 grönt** från en ren replay av 433 migrationer.

2. **Migrationsliggaren beskriver inte databasen.** Produktion har 358 rader i
   `public.nordklart_schema_migrations` mot 426 filer i repot (427 efter denna
   remediation). De 68 saknade migrationerna *är* applicerade — objekten finns
   (se `docs/audits/2026-08-07-live-database-verification.md` §3) — men de
   kördes utanför runnern utan att registrera en rad. Kräver en medveten
   skrivåtgärd av en operatör:
   `npm run db:migrate:mark-through -- 20260801140000_production_financial_atomicity_and_billing_lifecycle.sql`
   följt av `npm run check:migrations:db`, som nu failar tills detta är gjort.

3. **Supabase security advisor: 358 fynd.** 7 `security_definer_view` (ERROR)
   kvarstår. `public_price_*` är avsiktligt publik katalogdata; däremot behöver
   `customer_ar_balances`, `company_commercial_usage_v`,
   `agency_commercial_usage_v` och `company_effective_commercial_limits_v`
   granskas mot `security_invoker = true` — en `SECURITY DEFINER`-vy kringgår
   frågeställarens RLS. Cirka 21 funktioner har fortfarande rörlig
   `search_path` efter denna leverans (de 12 mest kritiska är nu pinnade).
   `auth_leaked_password_protection` är avstängt.

## Kvarvarande produktarbete (oförändrat, ej verifierat som klart)

4. Samlad produktionsroute som både länkar och vid behov bokar betalning av
   migrerade AR/AP-poster atomiskt.
5. Import av äldre kontoutdrag till radnivå (parser/UI).
6. Fullständigt fält-för-fält merge-UI mot Bolagsverket-snapshot.

## Ej åtgärdat av denna remediation

7. **H-03 — betalningsatomicitet.** Delvis. Den akuta produktionsstoppande
   buggen är fixad (se produktionsbuggar nedan): båda settlement-RPC:erna
   committade med `commit_method` som deras egen CHECK-constraint förbjöd, så
   ingen kund- eller leverantörsbetalning kunde genomföras alls. Happy path och
   negativa fall täcks nu av `settlement-atomicity.pg.test.ts` (8 tester).

   Kvar: själva atomicitetsrefaktorn. `markInvoicePaid()` skapar fortfarande
   draftverifikatet via `createDraftEntry()` före `settle_customer_invoice` och
   kompenserar vid fel. Fullständig design och call graph ligger i
   `decisions.md` (2026-08-07) — planvariant av radbyggarna + ny RPC som tar
   raderna som JSONB och skapar verifikatet inne i transaktionen. Radlogiken får
   inte flyttas till PL/pgSQL (dubbel domänsanning).

8. **H-05 — testmatrisen.** Concurrency, idempotens-race, failure injection,
   Stripe-livscykel och tenant-isolering i pg-real är fortfarande inte
   byggda. Att bygga ut sviten innan punkt 1 är löst är verkningslöst.

## Miljö

9. Bygget hämtar Google Fonts över nätet; hermetisk CI kan falla på det.

## Stängda antaganden (tidigare blockerare som nu är motbevisade)

- ~~"`SUPABASE_DB_URL`/`DATABASE_URL` saknas, ingen DB kan nås."~~ Live-projektet
  `rpajvvngvcutffwucbdy` är nåbart via Supabase-connectorn, och pg-real kördes
  lokalt mot PostgreSQL 16 med samtliga migrationer applicerade.
- ~~"Migration 424 får inte aktiveras i produktion."~~ Både 424 och 426
  (`20260801140000`) är applicerade i produktion; objekten är verifierade.
- ~~"Två dubbla migrationsversioner är ett olöst problem."~~ Produktion har
  ingen `supabase_migrations.schema_migrations`; den egna runnern är enda
  auktoritet och nycklar på fullt filnamn, så kollisionerna är entydiga där.
  CI-guarden bär dem som en stängd allowlist och blockerar nya.
- ~~"6 skills saknar proveniens."~~ `skills-lock.json` hade källa för samtliga
  41; det var den härledda TSV-filen som var föråldrad.
