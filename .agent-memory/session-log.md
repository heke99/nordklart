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

## 2026-08-08 — H-03 stängd: settlement skapar sitt eget verifikat

Unit 6163/6163, pg-real 529/529 (var 509), typecheck/lint/guards/feature-policy/
skills/provenance/build gröna.

`settle_customer_invoice` / `settle_supplier_invoice` tog ett draftverifikat som
applikationen redan hade committat i en EGEN transaktion, och annullerade det
efteråt om settlementet rullade tillbaka. Den kompensationen är per definition
best effort: en process som dör mellan de två satserna lämnar ett verifikat utan
betalning bakom sig. Det var det tredje tillståndet H-03 handlade om.

Genomfört exakt enligt designen i `decisions.md` (2026-08-07):

1. `plan*`-varianter av alla fyra radbyggarna returnerar `CreateJournalEntryInput`
   utan att skriva. `create*` är kvar som tunna wrappar — alla andra anropare är
   orörda och beteendet är oförändrat.
2. `20260808120000_settlement_creates_its_own_voucher.sql`:
   `create_planned_draft_entry()` (delad, service-role, låser perioden, slår upp
   `account_id` mot företagets kontoplan, avvisar okända konton och obalanserade
   planer) plus `settle_customer_invoice_v2` / `settle_supplier_invoice_v2`.
   Allt efter verifikatskapandet är byte-identiskt med v1. v1 ligger kvar.
3. Servicelagren skickar planen som `p_journal` och resolvar voucher-serien som
   en läsning. Draft-annulleringen är borttagen.

Radlogiken flyttades INTE till PL/pgSQL. RPC:n persisterar en plan den får; den
avgör aldrig vilka konton en betalning träffar.

`settlement-v2-atomicity.pg.test.ts` (20 tester) bevakar rätt invariant: inte att
happy path fungerar, utan att ett avvisat settlement inte lämnar NÅGOT verifikat
kvar — inte ens ett annullerat. Åtta av testerna avvisar via olika vägar (ej
betalbar, stale remaining, fel företag, obalanserad plan, konto utanför
kontoplanen, fel `source_id`, fel `source_type`, låst period) och kräver att
`journal_entries` för källan är tom efteråt.

`check:financial-hardening` kräver nu v2-anropen och förbjuder `createDraftEntry(`
och `from('journal_entries')` i båda servicelagren, så mönstret inte kan smyga
tillbaka.

Testklassning för de sex sviter som behövde ändras: samtliga TEST_STALE mot ett
avsiktligt ändrat kontrakt (planering i stället för staging). Inga assertions
försvagades — argumentindex flyttades där signaturen tappade `userId`/`options`,
och v1-sviternas `journal_entry_id` härleds nu ur planens `source_type`, vilket
fortfarande skiljer accrual- och kontantvägen åt.

## 2026-08-08 (forts.) — H-05, Stripe, redefinitionsgranskning och FYRA säkerhetsfynd

unit 6175/6175, pg-real 640/640 (var 529), typecheck/lint/guards/build gröna.

### Nya produktionsbuggar

16. **`__year_end_prior_result_transfer` committade med `commit_method='system'`**
    som CHECK-constraintet förbjöd → 23514. Tredje instansen av samma klass.
    Träffar andra på varandra följande bokslut för ett AB (omföring 2099→2098).
    Alla befintliga bokslutstester stänger ett FÖRSTA år, som saknar 2099-saldo
    — samma success-path-blindfläck som de två settlement-incidenterna.
    Hittad av drift-guarden som byggdes för att fånga just detta.

17. **Fyra vyer läckte över tenantgränsen.** En vy kör med ÄGARENS rättigheter
    om den inte har `security_invoker = true`. `customer_ar_balances`,
    `company_commercial_usage_v`, `company_effective_commercial_limits_v` och
    `agency_commercial_usage_v` saknade tenantfilter, ägdes av superuser och var
    SELECT-grantade till `authenticated`. Mätt som vanlig medlem i ett företag:
    388 / 4 433 / 22 165 / 104 främmande rader. `customer_ar_balances` innehåller
    kundreskontra per företag — varje tenants orderbok läsbar för alla andra.

18. **`commit_journal_entry` saknade auktorisering helt.** SECURITY DEFINER,
    EXECUTE till anon+authenticated via PUBLIC-granten, och `auth.uid()` användes
    bara som attributionsfallback. En autentiserad medlem i vilket företag som
    helst kunde posta ett annat företags utkastverifikat. Postade verifikat är
    oföränderliga enligt lag — offret kan bara stornera, så båda verifikaten
    ligger kvar permanent. Samma anrop som `anon` nådde också
    verifikationsnumret; det stoppades en sats senare enbart av att en
    icke-definer-trigger saknar SELECT på `journal_entry_lines` för den rollen.

19. **147 write-policies auktoriserade på läsmedlemskap.** `company_id IN
    (SELECT user_company_ids())` betyder "är medlem", vilket en viewer är. 57
    tabeller — leverantörsfakturor, betalningar, lönekörningar, kontoplanen,
    räkenskapsår — lät en viewer INSERT/UPDATE/DELETE. Supabase publicerar
    PostgREST med användarens egen JWT, så appens `requireWrite` är inte
    kontrollen: en viewer kan PATCH:a `/rest/v1/supplier_invoices` direkt.
    `invoices`/`journal_entries` hade redan rätt predikat; ändringen hade aldrig
    spridits vidare.

### Redefinitionsgranskningen (P10/P11)

253 objekt är definierade i mer än en migration. 41 kritiska spåras nu i
`supabase/critical-object-redefinitions.json`. Två pass: kronologisk
token-diff, och — den avgörande — tokens som finns i historiken men saknas i
den definition som faktiskt överlevde. Fyra flaggade, alla fyra verifierade
individuellt och benigna (delegationskedjor, uppgradering till den kanoniska
resolvern, ett medvetet hårdfel). `npm run check:redefinition` failar nu bygget
när antalet definitioner för ett spårat objekt ändras.

### Nya guards som inte kan tystna

- `commit-method-provenance` jämför varje `commit_method`-literal som någon
  live-funktion skriver mot CHECK-constraintet.
- `security-definer-search-path` kräver pinnad search_path på alla SECURITY
  DEFINER och att pgcrypto-anropare behåller `extensions` på vägen.
- `view-tenant-isolation` failar på ny definer-vy som är tenantläsbar.
- `tenant-isolation-matrix` failar på write-policy som auktoriserar på
  läsmedlemskap.

Samtliga läser live-katalogen, inte migrationstexten, så de bedömer den
definition som överlevde alla senare redefinitioner.

## 2026-08-21 — P0-härdning deployad till produktion

unit 6193/6193, pg-real 696/696 (96 filer), typecheck/lint/7 guards/feature-policy
gröna, 454 migrationer replayar rent från tom databas.

Fyra migrationer deployade via `deploy-migration-via-mcp.mjs` + Supabase MCP,
i versionsordning, med checksumverifiering i databasen före varje `EXECUTE`.
Liggaren står på **454**, staging tömd.

### Vad som rättades

1. **MFA-bypass.** `shouldEnforceMfa` undantog varje konto med `bankid_linked`.
   `POST /bankid/link` sätter den flaggan på ett befintligt lösenordskonto, och
   flaggan säger ingenting om hur den *aktuella* sessionen upprättades — så att
   länka BankID tog bort andra faktorn från lösenordsinloggningen. Undantaget
   kräver nu också att kontot saknar eget lösenord.

2. **Storno/rättelse var inte atomiska.** `reverseEntry` gjorde 5+ skrivningar,
   allokerade verifikationsnumret i förväg (varje senare fel brände ett nummer)
   och postade med rå `UPDATE status='posted'` — förbi `commit_journal_entry`
   och därmed förbi anon-guarden och skrivkontrollen från 20260808190000.
   `reverse_journal_entry_v2` gör allt i en transaktion. Planen byggs i TS.

3. **Falsk betalvägg.** Vy-fallbacken i `listCompanyFeatureAccess` tappade
   `reason`; layouten litade på `enabled === false`. Degraderade rader
   om-verifieras nu via `checkFeatureAccess`.

4. **Personnummer.** `customers.personal_number` skrevs aldrig av någon
   kodväg — formuläret samlade in det och båda routes utelämnade det. Nu
   inkopplat och krypterat (`_enc` + `_last4`); klartextkolumnen borttagen
   efter att migrationen bevisat att den var tom (0 rader i produktion).

5. **Signaturbevis.** `markSignatureSigned` fyllde aldrig
   `signer_personnummer_hash`/`_encrypted`, och felet sväljdes — samtycket
   registrerades, sessionen blev `complete`, signaturbegäran stod kvar
   `pending`. `record_bankid_consent_v1` skriver allt i en transaktion.

### Produktionsbugg som hittades på vägen

`audit_annual_report_document_change` delas av tre tabeller men läste
`NEW.created_by`, som bara en har. TG_TABLE_NAME-guarden skyddar inte:
PL/pgSQL cachar planen på funktionen, inte per radtyp. När en backend kört
triggern för `annual_report_presentation_reclassifications` dog nästa skrivning
mot `arsredovisning_signature_requests` eller `arsredovisning_narratives` på
samma connection med `record "new" has no field "created_by"`. Årsredovisnings-
signering gick alltså sönder beroende på vad den poolade anslutningen råkat
röra först. Testet reproducerades mot den gamla definitionen före fixen.

### Verifiering mot produktion efter deploy

Content-fingerprint mot ren replay: `column`, `constraint`, `index`, `policy`,
`rls`, `trigger`, `view` identiska. `function` identisk (**283 /
c3212a5026000b9eb0304bafd00c1061**) när extension-ägda objekt exkluderas —
produktion installerar `btree_gist` i `public` (188 funktioner), den lokala
bootstrappen i `extensions`. Det är miljöskillnad, inte drift.

**Ny observation, ej åtgärdad:** grant-raderna skiljer sig (`table_grant`
2 395 lokalt mot 6 198 i produktion, `function_grant` 632 mot 703). Det är
Supabases default-grants. De är verkningslösa här — `anon` har `rolbypassrls`
= false, 0 av 279 tabeller saknar RLS, och **0 policies nämner `anon`**, så
anon matchar ingen policy och ser ingenting. Men det betyder att den lokala
pg-real-replayen grantar *mindre* än produktion: ett test kan passera lokalt
för att granten saknas, medan produktion bara har RLS som grind. Bör tas upp i
nästa granskningspass.

Nya funktioners rättigheter verifierade i produktion:
`reverse_journal_entry_v2`, `record_bankid_consent_v1` och
`create_planned_draft_entry` är service_role-only; `commit_journal_entry` är
fortsatt `authenticated` (den bär sin egen anon-guard och skrivkontroll).

### Nya guards

- `internal-links` — failar på intern länk utan route bakom sig. Reproducerar
  båda 404:orna (`/documents`, `/inbox`) mot den gamla koden.
- `financial-hardening` kräver storno-RPC:n och förbjuder både postning utanför
  `commit_journal_entry` och förhandsallokerat verifikationsnummer i motorerna.
- Tre nya service-role-anropsställen granskade i
  `docs/audits/2026-08-21-service-role-additions.md`.

## 2026-08-21 (forts.) — BankID-konvergens, Skatteverket-ombud, röjning

Tre commits till på `claude/nordklart-production-ready-w4szxu`, fem migrationer
deployade till produktion (ledger 454 → 459, staging-tabellen tom efteråt).

### BankID (`2a428a5`, migrationer 20260821160000/170000/180000)

Login var det enda BankID-flödet som inte gick via `getBankIdProvider()`.
Konsekvenserna: `NEXT_PUBLIC_BANKID_ENABLED` stängde av samtyckessignering men
inte inloggning; en hostad deploy med trasig provider-registrering hade inget
skydd mot att falla igenom till mock; och det enda flöde som delar ut en
session lämnade inget spår. Start/poll/complete/link/cancel går nu genom
providern. `BankIdProvider` fick `result()` — en idempotent läsning av ett
avslutat ärende, eftersom completion-steget måste härleda utfallet från
providern i stället för att tro på webbläsaren, och `collect()` konsumerar
progress.

`bankid_sessions.user_id` är nullbar för `purpose='auth'` (CHECK), eftersom ett
login-ärende startar innan kontot är känt. RLS behövde ingen ändring:
`user_id = auth.uid()` är aldrig sant för NULL. Oanspråkade rader städas efter
30 dagar från dygnscronen.

`bankIdStartCooldowns` (in-memory Map, per instans, tom efter varje cold start)
ersatt av `checkDurableRateLimit`: Upstash när det finns, annars fixed-window i
Postgres, **fail-closed** — varje start är en debiterad TIC-session och rutten
är oautentiserad.

QR-koden räknade `setInterval`-tick sedan mount. BankID:s `time`-fält är
sekunder sedan *ordern skapades på servern*. Skillnaden är starttiden, varje
långsam HMAC, och tiotals sekunder i en bakgrundsflik där intervallet stryps —
varefter varje skanning misslyckades. Nu klockbaserat mot ett serveransatt
ankare.

Borttaget: BankID-signup (ingen entry point, skapade konto utan avtal, plan
eller bolag — CWE-287-guarden är nu strukturell i stället för en gren),
`user_identity_verifications` (tom i både replay och produktion, aldrig
skriven, dubblerade `bankid_sessions`).

### Skatteverket (`bba74ef`, migrationer 20260821190000/200000)

`skatteverket_ombud_authorizations`: `status='active'` går bara att nå genom ett
observerat providersvar. Inga skrivgrants till anon/authenticated, RLS bara
SELECT, skrivning via service-role-RPC som *härleder* status ur observationen,
CHECK-villkor som binder status till bevis, och en trigger som vägrar varje
skrivning RPC:n inte gjort — så en framtida service-role-väg kan inte heller
sätta den för hand. Verifierat i produktion: `authenticated` kan varken köra
RPC:n eller INSERT:a.

Verdikt härleds bara ur två svar: lyckat anrop → `active`, 403 med
behörighetstext → `denied`. En 500, en 401, en utgången session eller ett
saknat scope säger ingenting om behörighet, och `denied` ur något av dem hade
strandat ett giltigt ombud.

Retry: `skvSysorgRequest` hade ingen alls. Nu bounded, med två regler — aldrig
POST (Skatteverket har ingen idempotensheader; en timad POST kan redan ha
lämnat in, och ett lyckat andra försök ger två deklarationer), och bara
timeout/429/502/503/504 med exponentiell backoff + full jitter.
`skatteverket_api_requests` fick `idempotency_key`, `attempt_count`,
`next_retry_at`.

Även: `getSkvSysorgAccessToken()` gate:ar nu på samma predikat som
readiness-panelen, och de två moms-övergångarna krävde bara `if (data)` — ett
200 med tom kropp hade flyttat en inlämning till `signed_submitted`.

### Röjning

Rotartefakterna borta (`nordklart-canonical-year-end.patch` — verifierat att
den varken applicerar eller reverserar — plus `apply.sh`, som `rm -rf`:ade
sökvägar i vilken katalog den än pekades mot). `findings.md` (116 KB, frusen
2026-04-22) statusmärkt och flyttad till `docs/audits/`.

`.env.example` fanns inte, och `docker-entrypoint.sh` hänvisade till en
`.env.docker.example` som aldrig legat i repot. Nu finns filen, och
`scripts/checks/env-example.mjs` failar när kod läser en variabel den inte
nämner. Guarden ser även indirekta läsningar (`firstEnv`/`boolEnv`,
`aliases:`-listorna, `env.NAME` i readiness-registret) — det var de ~23
Skatteverket-variablerna en `process.env.NAME`-scan missar helt.

### Kvar till nästa pass

Grant-divergensen mot produktion (se ovan) är fortfarande bara antecknad.
`enforceSkvRateLimit` i `lib/skatteverket/sysorg/client.ts` är samma
per-instans-räknare som BankID-cooldownen var; den är en artighetsstrypning mot
SKV, inte en säkerhetskontroll, och byts bara om granskningen visar att det
spelar roll.

### Andra granskningen (§90) — ett kritiskt fynd

Granskningen började med att göra pg-real-replayen *trogen* i stället för
smickrande. `tests/pg/bootstrap-plain-postgres.sql` grantade default-privilegier
till `authenticated, service_role` och utelämnade `anon`, medan produktionen
grantar anon allt. Replayen var alltså säkrare än produktionen — den farliga
riktningen: en saknad kontroll var onåbar lokalt och öppen live, och sviten blev
grön i båda fallen.

Med anon tillagd syntes det direkt: **144 SECURITY DEFINER-funktioner i
`public` kunde köras av anon**, varav 39 utan någon egen kontroll.
Reproducerat: `SET ROLE anon; SELECT public.company_entity_type('<valfritt
bolag>')` → `aktiebolag`. Även `check_email_exists` (användarenumerering) och
skrivande funktioner som `seed_chart_of_accounts` och `finalize_sie_import`.

Åtgärdat i `20260821210000` genom att ta bort granten i stället för att lappa 39
funktionskroppar — inget i produkten anropar en SECURITY DEFINER-funktion som
anon (verifierat över `app/`, `lib/`, `components/`, `extensions/`).
Produktionen: 144 → 0. `authenticated` (160) och `service_role` (223) orörda,
`user_company_ids` fortsatt körbar för authenticated, prisvyerna fortsatt
läsbara för anon.

Notera: `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
gör **inte** vad man tror. PostgreSQL lägger sin inbyggda `GRANT EXECUTE TO
PUBLIC` ovanpå `pg_default_acl`, så en nyskapad funktion kommer ut
anon-körbar oavsett. Det som håller ytan stängd är
`tests/pg/anon-security-definer-surface.pg.test.ts`, som failar så fort någon
SECURITY DEFINER-funktion i `public` blir anon-körbar igen. Ett av testfallen
skapar med flit en sådan funktion och verifierar att den ÄR öppen, så skälet
till att per-funktions-REVOKE är obligatoriskt står skrivet där nästa person
läser det.

Grant-divergensen som stod som "ej åtgärdad" i förra anteckningen är därmed
avklarad: den lokala replayen har numera produktionens grant-hållning, och de
invarianter som gör tabellgranten verkningslös (RLS på alla tabeller, ingen
policy nämner anon) är testade i stället för antecknade.
