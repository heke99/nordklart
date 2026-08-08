# Sessionslogg

## 2026-07-29

- Läste hela målbeskrivningen, projektreglerna och befintlig bokslutsarkitektur.
- Checksummade 417 befintliga migrationer och lämnade dem orörda.
- Implementerade tre forward-only migrationer för SIE-identitet/sessioner,
  stödregister samt bokslut/årsredovisning.
- Samordnade dashboard- och v1-SIE-importen med samma identitet, storleksgräns,
  arkiv och statusmodell.
- Byggde historiskt stödregister-API och en period-/företagsbunden arbetsyta.
- Kopplade kontrollstatus, snapshot, disposition och anteckningar till
  bokslutsguiden och årsredovisningen.
- Rättade AR-kontrollkontodrift och utdelningsklassificering.
- Lade unit- och pg-real-tester.
- Installerade låsta npm-beroenden med skrivbar cache.
- Körde 6 109 unit-tester, typecheck, ändrad-fil-lint, lintbaseline, guards och
  produktionsbygge.
- Försökte köra pg-real och migrationsstatus; dokumenterade de verkliga
  miljöblockeringarna utan att markera dem som passerade.

## 2026-07-30

- Kartlade kvarvarande falska blockerare i det historiska bokslutsflödet.
- Införde kanoniska workpapers, källprioritet, append-only historik,
  återimportskonflikt, automatisk refresh och idempotent backfill.
- Samordnade status/belopp/källa mellan databas, API, readiness och UI.
- Lade massbekräftelse utan journal, klassificerad manuell justering,
  resultatdispositionsförslag och explicit kontrollkontomappning.
- Uppdaterade evidensflödet så starkare källor synkroniseras till workpaper.
- Lade diagnostik, teknisk leveransrapport och regressionstester.
- Körde 6 112 unit-tester, typecheck, ändrad-fil-lint, lintbaseline, guards,
  PostgreSQL-parser, migrationslista och produktionsbygge.
- Försökte köra pg-real; dokumenterade `ECONNREFUSED :5432` som
  miljöblockering.
- Återställde mottagen projektbaslinje och etablerade exakt lokal Git-diff.
- Kartlade direktbokning, delbatch, flyktig preview, klientstyrd utdelning och
  det breda SIE-undantaget som konkreta P0-avvikelser.
- Byggde staging → beständig preview → atomisk execute med versionsbundna
  snapshots, reverseringsschema, run-resultat och outbox.
- Samordnade API, wizard, iXBRL och Bolagsverket med den kanoniska kedjan.
- Lade serverbaserad resultatbekräftelse och återläsning av stängd körning.
- Körde typecheck, lintbaseline, guards, 6 114 unit-tester,
  PostgreSQL-parser och produktionsbygge med godkänt resultat.
- Slutförde gemensam projicerad huvudbok, tom gruppersättning, strukturerad
  API-felhantering och periodbunden rapportåtkomst.
- Lade migration 423 med separata justeringskällor, idempotensåterspelning och
  retry/dead-letter-processorer för återföring och outbox.
- Rättade processorns transaktionsgränser, handlerfel och de sista API-/kö-
  kompatibilitetsfallen.
- Slutverifierade 6 120 unit-tester, typecheck, lintbaseline, guards,
  feature-policy, 35 PostgreSQL-statements, migrationsordning och ett komplett
  produktionsbygge med 356 routes/sidor.
- Dokumenterade live-DB och pg-real som ej körda eftersom databas-URL saknas.

## 2026-07-31

- Kartlade execute-kedjan från wizard via route/service till preview, staged
  adjustments, run-tabell, final close, nästa period och IB.
- Identifierade felaktigt partiellt index, för breda RPC-grants, saknad
  `retryable`, textbaserad felklassificering, gissade RPC-resultat, första
  framtida period och blockerad återanvändning av korrekt IB.
- Implementerade migration 424, typade fel/resultat, scope-idempotens,
  statusmaskin, recovery, full audit/outbox och UI-återläsning.
- Upptäckte i andra granskningsvarvet att serverlåsta staging-RPC:er fortfarande
  anropades med användarklient i tre routes och rättade samtliga.
- Lade kombinerat pg-real-scenario för två dispositioner, skatt och
  periodisering samt regressioner för IB, datumglapp och grants.
- Körde och godkände typecheck, 6 128 unit-tester, ändrad-fil-lint, full lint,
  guards, feature-policy, PostgreSQL-parser och produktionsbygge.
- Försökte migrationsstatus och pg-real; dokumenterade saknad DB-URL och
  `ECONNREFUSED localhost:5432` utan att räkna dem som godkända.

## 2026-08-07 — Remediation av systemkonsistensauditen 2026-08-06

Utgångspunkt: `origin/main` @ `a8dee572` (= auditens baseline). Auditrapporten
låg bara på auditbranchen `audit/nordklart-system-consistency-2026-08-06`
(`63849a9d`) och hämtades därifrån; ingen produktionskod ändrades där.

Verifierade varje fynd själv i stället för att lita på rapporten. Resultat som
avviker från auditen:

- **H-04 inte reproducerbar** — produktionsdatabasen är ren och pre-launch;
  de ovillkorliga unika indexen finns redan.
- **M-02 delvis felaktig** — proveniens saknades inte, den härledda TSV:n var
  föråldrad.
- **M-03 delvis felaktig** — den citerade raden i `mark-paid-service.ts` är ett
  balanspredikat i öre, inte en beloppsberäkning.
- **H-06 avgjord empiriskt** — produktion har ingen Supabase-CLI-historik alls,
  så det finns bara en migrationssanning där.
- **R-01 bekräftad som exploaterbar**, men som privilegieeskalering inom en
  tenant (viewer → skriv på bokslutslåsning), inte som cross-tenant-bypass.

Nya fynd som auditen inte hade:

1. pg-real är rött på `main`: 36/501 failar (baslinje 37). Osynligt eftersom
   pg-real bara kördes på `pull_request` och inga PR:er fanns.
2. Migrationsliggaren i produktion saknar 68 rader trots att SQL:en är
   applicerad — och `--db`-kontrollen kunde aldrig se det, eftersom riktningen
   repo→registry beräknades men aldrig jämfördes.
3. Repo-wide typecheck-fel på `main` som `next build` inte fångar.
4. `requireYearEndReportAccess()` hade samma bypassform som R-01.

Kört: `npm ci`, `npx tsc --noEmit` (grönt), `npm run check:guards` (grönt),
`npm run check:skill-provenance` (grönt), unit-tester för berörda områden
(grönt), samt full pg-real mot lokal PostgreSQL 16 med alla 427 migrationer
applicerade — 36 failar, alla pre-existerande (baslinje utan 2026-08-07-
migrationen: 37, dvs. migrationen fixar ett test och bryter inget).

Ej gjort: H-03 (betalningsatomicitet) och H-05 (utbyggd testmatris). Att bygga
ut sviten innan de 36 befintliga failen är rättade ger inget bevisvärde.

## 2026-08-07 (forts.) — pg-real från 37 till 12, fyra riktiga produktionsbuggar

Fortsatte enligt egen prioritering: pg-real före H-03/H-05. Att köra sviten mot
en riktig PostgreSQL visade sig vara det som faktiskt hittade buggar — fyra av
de fem fixarna nedan är verifierade som trasiga även i produktion.

1. **Föräldralös migration.** `20260731163000_year_end_pgcrypto_search_path_repair.sql`
   låg i `supabase/migrations/supabase/migrations/` — en nästlad dubblett.
   Alla konsumenter globbar `supabase/migrations/*.sql`, så runnern, manifestet
   och pg-real-bootstrappen hoppade över den. Den var git-spårad och såg därmed
   levererad ut. Den reparerar `digest`-incidenten; produktion hade fixen
   manuellt applicerad, repot hade den aldrig. Flyttad in i kedjan + ny guard
   som failar på .sql i underkatalog.

2. **SIE undo/replace trasigt i produktion.** `__sie_reverse_import_entries()`
   committar med `commit_method = 'sie_import_reversal'`, men
   `journal_entries_commit_method_check` tillåter inte värdet. Varje undo och
   varje replace rullar tillbaka. Verifierat i produktion. Värdet tillagt i
   vokabulären (migration 20260807130000).

3. **`mark_entry_as_opening_balance` trasigt i produktion.** RPC:n sätter
   `nordklart.allow_source_type_retag`, men härdningsmigrationen 20260801140000
   skrev om `enforce_journal_entry_immutability()` och tappade carve-outen som
   läser flaggan. Återställd verbatim i omfattning (20260807140000).

4. **`delete_last_voucher` trasigt i produktion.** Kontrollerad un-reversal
   sätter `status='posted', reversed_by_id=NULL`, men diff-kontrollen avvisade
   allt utom `status`. `reversed_by_id` är nu undantagen och måste bli NULL.

5. Föråldrade fixtures/assertions: org_number, company_settings, manuell
   kassaavstämning, `YE_READINESS_BLOCKED`-kontraktet, och tre sviter som
   fejkade en reversering med en naken status-UPDATE (numera
   `reversePostedEntry()` som skapar en riktig länkad storno).

Ingen produktionskod försvagades, inget test avstängdes. Varje carve-out som
återställdes är den snävaste som får den parade RPC:n att fungera.

## 2026-08-07 (forts. 2) — pg-real 501/501, tre produktionsbuggar till

Phase 1 avslutad: `npm run test:pg` är **0 failures** (501/501) från en ren
replay av samtliga 433 migrationer. Tre av de sista tolv var riktiga produktfel:

6. **Batchallokering av bank var omöjlig.** H-04-härdningen la
   UNIQUE (company_id, transaction_id) på invoice_payments och
   supplier_invoice_payments samt en trigger som avvisade en transaktion som
   redan hade NÅGON betalningsrad i NÅGON av tabellerna. Men
   `match_batch_allocate()` skapar en betalningsrad per faktura med samma
   transaction_id — en bankgirobetalning som reglerar flera leverantörsfakturor
   är helt normalt. Varje flerfaktura-allokering föll på
   BANK_TRANSACTION_ALREADY_ALLOCATED. Verifierat trasigt i produktion.
   Unikheten är nu per (transaktion, faktura). Belopps-invarianten är orörd:
   allokeringen måste redan exakt motsvara ABS(transaktionsbeloppet).

7. **`is_reconciled` blev NULL för korrekt återskapad AR/AP.**
   `__year_end_open_item_reconciliation_json()` hämtar den valfria externa
   avstämningen med en icke-aggregerande `SELECT ... INTO`. Utan extern
   registrering returneras ingen rad och PL/pgSQL nollställer ALLA målvariabler,
   vilket raderade `:= false` på v_invalidated och
   v_external_source_invalidated. `is_reconciled` är en AND-kedja, så ett NULL
   gör hela uttrycket NULL. Saknad evidens dolde felet (NULL AND false = false);
   i samma stund som sista underlaget bifogades slog resultatet om från false
   till NULL i stället för true — kontrollen blev omöjlig att uppfylla och
   bokslutet permanent blockerat utan något användaren kunde göra.

8. **`imported_from_sie` tappades ur SIE-precedensen** (se separat commit).

Verifierat: replay-grenen i `execute_year_end_closing` returnerar det lagrade
resultatet före varje readiness-kontroll, så äkta idempotent replay kör aldrig
om readiness. Tidigare `manual_cash_reconciliation_missing` vid replay kom från
previewordningen i testet, inte från RPC:n. Ett preview snapshotar readiness och
måste därför skapas EFTER att blockerare är åtgärdade.

Unit: 47 → 43. Se open-blockers punkt 1 för ordningsanmärkningen mot H-03.

## 2026-08-07 (forts. 3) — H-03 påbörjad, total betalningsutestängning hittad

Nionde och tionde produktionsbuggen, och de allvarligaste hittills:
`settle_customer_invoice()` och `settle_supplier_invoice()` committar med
`commit_method` `'atomic_customer_settlement'` / `'atomic_supplier_settlement'`.
Ingetdera värdet lades till i `journal_entries_commit_method_check` i samma
migration. **Varje** kund- och leverantörsbetalning avbryts därför med
constraintbrott och hela transaktionen rullas tillbaka — kärnflödet "markera
faktura betald" fungerar inte alls i produktion. Verifierat mot livedatabasen.

Tredje förekomsten av samma defektform (jfr SIE-reverseringen): en funktion och
den constraint som styr dess skrivningar införs i samma migration och är ändå
oense.

Dolt eftersom pg-real bara körde ROLLBACK-vägen för settlement-kontraktet.
Ingen test drev någonsin en settlement till framgång. Nu täckt av
`settlement-atomicity.pg.test.ts`: postat verifikat med verifikationsnummer, en
betalningsrad kopplad till det, korrekt paid_amount/remaining_amount/status/
paid_at, delbetalning, idempotent replay, payload-hash-återanvändning,
cross-company-nekande, valutamismatch, stale expected-remaining och icke
betalbar status. Bevisat med ren A/B-replay: utan migrationen failar 4 tester
med constraintbrottet, med den 8/8 gröna.

`tests/pg/setup.ts` har nu `withServiceRole()` — de finansiella RPC:erna kräver
`require_service_role()`, som läser JWT-claim, inte PostgreSQL-rollen.

pg-real: 509/509. Unit: oförändrat 43.

## 2026-08-07 (forts. 4) — build grön, unit-baslinjen mätt mot main

`npm run build` kördes till slut: **exit 0**. Det var den sista overifierade
punkten i Definition of Done som gick att köra här.

Mätte unit-sviten på `origin/main` för att avgöra om grenen är mergebar:
main har **47 failures i 8 filer**, grenen har **43 i 6 filer**. Felen är alltså
ärvda, och grenen är strikt bättre på varje mätt axel. CI på main har varit röd
utan att någon sett det — vilket var remediationens första fynd.

Lade grunden för de återstående 43 (commit 9e97822): separat service-klientkö,
settlement-helpers och modulmockar som sprider `importOriginal`. Ingen ändring i
antal fel — kvarvarande arbete är per-test query-sekvensering. Metoden för att
härleda routernas verkliga läsordning finns i `open-blockers.md` punkt 1.

Obs: `git checkout origin/main -- .` återintroducerar den nästlade
`supabase/migrations/supabase/migrations/`-filen. Den togs bort igen och
`check:migrations` (som nu har en guard mot nästlade .sql) passerar.

## 2026-08-07 (forts. 5) — unit 47 -> 19, tre produktionsbuggar till

`match-invoice` är helt grön (31/31). pg-real 509/509. Alla guards, typecheck,
lint, build gröna. Unit: 19 kvar.

Tre nya produktionsbuggar, alla hittade genom att spåra vad routen FAKTISKT gör
i stället för att anta att testet var föråldrat:

11. **Force-override var dokumenterad men aldrig implementerad.**
    `MatchInvoiceSchema` tar `force` + `expected_journal_entry_id`, validerar att
    det andra krävs när det första är satt, och beskriver kontraktet i detalj —
    servern ska omdetektera kandidaten och bara godta override om id:t stämmer.
    Routen läste aldrig `expected_journal_entry_id` och använde `force` enbart
    till `forceIgnored: Boolean(force)`. Soft-duplicate-guarden är heuristisk
    (samma belopp, samma datum), så falska positiva är väntade — en användare som
    granskat verifikatet och korrekt svarat "detta är inte samma betalning" kunde
    **aldrig** slutföra matchningen. Nu implementerad som confirm-what-you-saw.

12. **FX-residual tappades när en SEK-skuld betalas i utländsk valuta.**
    `exchangeRateDifference` nycklades på FAKTURANS valuta:
    `invoiceCurrency === 'SEK' ? 0 : ...`. Omvända fallet — SEK-faktura betald
    från ett valutakonto där `amount_sek` skiljer sig — gav 0. Att betala en
    1 000 SEK-skuld med en kortrörelse värd 1 063 SEK är en realiserad förlust på
    63 SEK som aldrig nådde 7960/3960. Beräknas nu alltid som
    `roundOre(bookedSek - actualBankSek)`; vid SEK/SEK är de lika och värdet 0,
    och byggaren lägger bara en FX-rad vid nollskilt värde.

13. **Saknad `exchange_rate` tolkades som paritet.** `Number(invoice.exchange_rate ?? 1)`
    bokade en 25 USD-skuld som 25 SEK. Frånvaron är nu explicit: utan kurs kan
    AP-bokat SEK inte härledas, så betalningen bokas till faktiskt bankbelopp och
    ingen FX-differens attribueras.

Dessutom återställd FX-proveniens (`exchange_rate` + `rate_source`) i
matchningens audit trail, och `overpayment_amount` i felsvaret vid
cross-currency-överbetalning.

Testinfrastruktur: `enqueueFor()` gör mocken nycklad på relation/RPC-namn i
stället för positionell FIFO. Den positionella kön var grundorsaken till att en
rutinmässig omordning i routen svälte 18 tester och gav orelaterade
assertionsfel långt från orsaken.

## 2026-08-07 (forts. 6) — unit-sviten grön (0 av 6163), femtonde produktionsbuggen

`npm test`: 6163 passerade, 0 failade, 3 skippade (samma tre som tidigare —
orörda). Utgångsläget var 47 failures och `origin/main` har fortfarande 47.
pg-real 509/509. typecheck, lint, guards, feature-policy, skills, provenance
och build gröna.

15. **`supplier_invoice.paid` slutade emitteras.** `127bcf1` flyttade
    leverantörsbetalning bakom `settleSupplierInvoiceAtomic` och tog i samma veva
    bort `eventBus.emit` ur BÅDA mark-paid-routerna (dashboard + v1). Eventet
    står som `delivered: true` i `lib/webhooks/event-catalog.ts` och är den enda
    signal en integratör får för en leverantörsbetalning; kundsidan behöll sitt
    `invoice.paid` inne i sin service, så bortfallet var ensidigt och tyst.
    Återställt i servicen i stället för i routerna, så alla fyra anropare beter
    sig lika. Placerat under idempotens-short-circuiten: ett omförsök löser upp
    till samma committade betalning och får inte leverera ett andra event.
    Payloaden hydreras från den committade raden, med den obetalda snapshoten
    sammanslagen med RPC-resultatet som fallback.

De fyra sista testfilerna klassade före åtgärd:

- **v1 invoices mark-paid (3) och v1 supplier-invoices (3) — MOCK_STALE.**
  Båda sviterna mockar API-nyckelklienten (`createServiceClientNoCookies`) men
  inte `createServiceClient`, som settlement-servicen faktiskt använder. Routen
  byggde en riktig Supabase-klient och föll på saknade credentials. Varje svit
  har nu en egen settlement-klient som täcker replay-uppslaget, settle-RPC:n och
  hydreringsläsningen. Kundsidans ekar tillbaka `p_draft_journal_entry_id` så
  accrual- och kontantfallen fortsatt bevisar att de stagar olika verifikat.
- **stripe/webhook (2) — TEST_STALE.** En slutförd checkout kör numera två
  RPC:er: finalisering plus engångsköpets livscykel. Testet låste totalen till
  1. Nu låses den exakta ordnade sekvensen i stället, så det fortfarande failar
  om något anrop tappas, dubbleras eller byter ordning.
- **supplier-invoices mark-paid (2) — 1 PRODUCT_BUG (bug 15 ovan), 1
  TEST_STALE** (routen läser `company_settings` före servicen gör det, så den
  positionella kön gav accounting_method-raden till fel läsare).

Kontraktet från bug 15 är nu låst på servicenivå i
`lib/supplier-invoices/__tests__/mark-paid-service.test.ts`: emitteras vid
verklig settlement, emitteras INTE vid replay, faller tillbaka korrekt när
hydreringen är tom, och en trasig event-bus får inte fälla en redan committad
betalning.
