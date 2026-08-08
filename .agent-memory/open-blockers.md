# Aktiva blockerare och skuld

Uppdaterad 2026-08-07 efter remediation mot auditen 2026-08-06.

Allt nedan är verifierat i detta arbetspass. Punkter som tidigare stod som
blockerare men nu är motbevisade ligger under "Stängda antaganden".

## Blockerande före produktionsanspråk

1. **Unit-sviten: 19 av 6162 failar** (var 47 vid start; `origin/main` har 47).
   pg-real är 509/509 grönt.

   `match-invoice` är **helt grön (31/31)**. Kvar:
   - `supplier-invoices/[id]/mark-paid` — 6
   - `match-supplier-invoice` — 5
   - `v1 supplier-invoices` — 3
   - `v1 invoices mark-paid` — 3
   - `stripe/webhook` — 2

   **EXAKT NÄSTA EXEKVERINGSPUNKT**

   Fil: `app/api/transactions/[id]/match-supplier-invoice/route.ts`
   Guard: `!customLines && unbookedCashInvoice && invoiceCurrency !== 'SEK'`
   → `VALIDATION_ERROR` "Betalning av utländsk kontantmetodsfaktura kräver
   balanserade SEK-rader med betalningsdagens kurs."

   Routen blockerar i dag **alla** utländska kontantmetodsbetalningar. Avsett
   kontrakt enligt två tester + en oanvänd felkod i katalogen
   (`MATCH_SI_CASH_FX_UNSUPPORTED`, produceras ingenstans — samma död-kod-mönster
   som force-override i bug #11):

   - **Full** utländsk kontantsettlement ska TILLÅTAS och bokas till faktiskt
     bankbelopp i SEK, så 1930 matchar bankraden.
     Test: `full cross-currency settlement books at the payment rate`
     (förväntar `mockCreateCashEntry.mock.calls[0][9] === 239`).
   - **Partiell** utländsk kontantsettlement ska AVVISAS med
     `MATCH_SI_CASH_FX_UNSUPPORTED` (inte `VALIDATION_ERROR`).
     Test: `PARTIAL foreign payment under the cash method is still rejected`.

   Detta är en **produktändring som öppnar ett i dag blockerat bokföringsflöde**
   och ska göras med omsorg: verifiera att `settledBankSek` (arg index 9 till
   `createSupplierInvoiceCashEntry`) verkligen blir det belopp som lämnade
   banken, och lägg pg-real-täckning innan den aktiveras.

   Verktyg (klara): `enqueueFor(name, result)` på `createQueuedMockSupabase()`
   gör testerna oberoende av routernas läsordning; `enqueueCustomerSettlement()`
   / `enqueueSupplierSettlement()` köar service-sidans rundtur nycklad.
   Recept per test: keyed enqueues -> settlement -> flytta assertions från
   `createJournalEntry` till stagingbyggaren (`{ draftOnly: true }`).

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
