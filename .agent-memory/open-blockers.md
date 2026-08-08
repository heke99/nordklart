# Aktiva blockerare och skuld

Uppdaterad 2026-08-07 efter remediation mot auditen 2026-08-06.

Allt nedan är verifierat i detta arbetspass. Punkter som tidigare stod som
blockerare men nu är motbevisade ligger under "Stängda antaganden".

## Blockerande före produktionsanspråk

1. ~~**Unit-sviten failar.**~~ **STÄNGD.** Sviten är 6163/6163 grön (3 skippade
   sedan tidigare, orörda). Utgångsläget var 47 failures, och `origin/main` har
   fortfarande 47. pg-real är 509/509 grönt. Inget test är borttaget, skippat
   eller nedgraderat — varje failure klassades först (TEST_STALE /
   PRODUCT_BUG / MOCK_STALE / CONTRACT_DRIFT) och åtgärdades i den änden
   klassningen pekade på. Fyra av dem var produktbuggar, inte testskuld.

   **EXAKT NÄSTA EXEKVERINGSPUNKT**

   H-03-atomicitetsrefaktorn (punkt 7 nedan). Design och call graph ligger
   färdiga i `decisions.md` (2026-08-07). Grönt testläge är förutsättningen som
   saknades — den finns nu, så refaktorn kan göras med en svit som faktiskt
   fångar regressioner.

   Verktyg (klara): `enqueueFor(name, result)` på `createQueuedMockSupabase()`
   gör testerna oberoende av routernas läsordning; `enqueueCustomerSettlement()`
   / `enqueueSupplierSettlement()` köar service-sidans rundtur nycklad. De två
   v1-sviterna har egna settlement-klienter (`makeSettlementClient` respektive
   `setSettlementClient`) eftersom de mockar API-nyckelklienten och inte
   `createServiceClient`.

2. **Migrationsliggaren beskriver inte databasen.** Produktion har 358 rader i
   `public.nordklart_schema_migrations` mot 426 filer i repot (427 efter denna
   remediation). De 68 saknade migrationerna *är* applicerade — objekten finns
   (se `docs/audits/2026-08-07-live-database-verification.md` §3) — men de
   kördes utanför runnern utan att registrera en rad. Kräver en medveten
   skrivåtgärd av en operatör. Verktyget finns nu:

   ```
   SUPABASE_DB_URL=... npm run db:ledger:reconcile           # dry run, default
   SUPABASE_DB_URL=... npm run db:ledger:reconcile:apply     # skriver rader
   npm run check:migrations:db                               # bekräftar
   ```

   Det klassar varje fil mot vad databasen faktiskt innehåller: RECORDED,
   APPLIED_BUT_UNRECORDED, SUPERSEDED, NOT_APPLIED, CHECKSUM_MISMATCH,
   AMBIGUOUS. Endast APPLIED_BUT_UNRECORDED skrivs, och bara med `--apply`.
   NOT_APPLIED hör till `npm run db:migrate`; SUPERSEDED (objekten är borttagna
   av en senare migration, så frånvaro bevisar ingenting) och AMBIGUOUS kräver
   en människa. Verifierat i båda riktningarna mot den lokala replay-databasen:
   0 NOT_APPLIED när allt är applicerat, och rätt fil flaggas som NOT_APPLIED
   när dess objekt tas bort.

3. **Supabase security advisor: 358 fynd (omgranskade 2026-08-08).** Se
   `docs/audits/2026-08-08-supabase-advisors-and-ledger.md`. Produktion ligger
   12 migrationer efter branchen, så fynden måste läsas mot branchens slutläge.
   Fyra vyer, `commit_journal_entry` och 147 write-policies är åtgärdade;
   leaked-password protection kvarstår som EXTERNAL OPERATOR ACTION.

   Historisk formulering:
   **Supabase security advisor: 358 fynd.** 7 `security_definer_view` (ERROR)
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

7. ~~**H-03 — betalningsatomicitet.**~~ **STÄNGD.** Både den akuta
   produktionsstoppande buggen (settlement-RPC:erna committade med
   `commit_method` som deras egen CHECK-constraint förbjöd) och själva
   atomicitetsrefaktorn är klara.

   `20260808120000_settlement_creates_its_own_voucher.sql` inför
   `settle_customer_invoice_v2` / `settle_supplier_invoice_v2`, som tar
   verifikatet som `p_journal` och skapar det inne i settlement-transaktionen.
   Servicelagren bygger planen utan att skriva något; den kompenserande
   draft-annulleringen är borttagen eftersom det inte finns något att
   kompensera. Radlogiken ligger kvar i TypeScript (`plan*`-varianterna) —
   ingen dubbel domänsanning. `settlement-v2-atomicity.pg.test.ts` (20 tester)
   bevakar invarianten att ett avvisat settlement inte lämnar något verifikat
   kvar, och `check:financial-hardening` förbjuder nu `createDraftEntry(` och
   `from('journal_entries')` i båda servicelagren. Detaljerna i `decisions.md`.

8. **H-05 — testmatrisen.** Delvis. Idempotens-replay, payload-reuse,
   tenant-isolering och failure injection för båda settlement-vägarna finns nu i
   `settlement-atomicity.pg.test.ts` + `settlement-v2-atomicity.pg.test.ts` (28
   tester). Kvar: äkta concurrency-race (två samtidiga transaktioner mot samma
   faktura) och Stripe-livscykeln i pg-real.

9. **Kvarvarande releasekrav som ännu inte är körda.** Bokslutsmatris,
   SIE-matris, engångsköps-E2E, tenant-isoleringsmatris, genomgången av
   migrationer som omdefinierar funktioner (+ permanent CI-guard),
   reconciliation-verktyget för migrationsliggaren (RECORDED /
   APPLIED_BUT_UNRECORDED / NOT_APPLIED / AMBIGUOUS, dry-run som default),
   prestandagenomgång, cache-/rate-limit-genomgång och andra passet.

## Miljö

10. Bygget hämtar Google Fonts över nätet; hermetisk CI kan falla på det.

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
