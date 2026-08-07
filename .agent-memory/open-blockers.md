# Aktiva blockerare och skuld

Uppdaterad 2026-08-07 efter remediation mot auditen 2026-08-06.

Allt nedan är verifierat i detta arbetspass. Punkter som tidigare stod som
blockerare men nu är motbevisade ligger under "Stängda antaganden".

## Blockerande före produktionsanspråk

1. **pg-real är rött på `main`.** 36 av 501 tester i 14 filer failar mot en
   riktig PostgreSQL med samtliga 427 migrationer applicerade. Baslinjen på
   `main` (utan 2026-08-07-migrationen) är 37 failade. Detta är alltså inte
   orsakat av remediationen — sviten har drivit ifrån koden och ingen har sett
   det, eftersom pg-real bara kördes på `pull_request` och det inte fanns några
   öppna PR:er. Tyngdpunkt:
   - `year-end-atomic-close.pg.test.ts` — 10
   - `sie-import-engine.pg.test.ts` — 7
   - `mark-entry-as-opening-balance.pg.test.ts` — 4
   - `year-end-historical-support.pg.test.ts` — 3
   - resterande 12 spridda över 10 filer.

   Två tydliga orsaksklasser, båda äkta (inte miljöartefakter):
   - **Ändrat felkontrakt.** Testerna väntar `YE_NOT_READY` /
     `YE_NEXT_PERIOD_NOT_CONTIGUOUS`, koden kastar numera
     `YE_READINESS_BLOCKED: <reason>`.
   - **Föråldrade fixtures.** Seedade bolag saknar fält som nyare migrationer
     kräver, vilket ger `YE_READINESS_BLOCKED: company_details_incomplete` och
     `SIE_COMPANY_IDENTITY_MISSING_IN_SIE` innan det testade villkoret nås.

   Detta måste åtgärdas genom att rätta testerna mot det faktiska kontraktet —
   inte genom att skruva tillbaka koden och inte genom att stänga av tester.

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

7. **H-03 — betalningsatomicitet.** `mark-paid-service.ts` stagar fortfarande
   ett draft-verifikat före settlement-RPC:n och kompenserar vid fel. Rätt fix
   är att flytta draftskapandet in i `settle_customer_invoice` /
   `settle_supplier_invoice`. Inte påbörjat i detta pass.
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
