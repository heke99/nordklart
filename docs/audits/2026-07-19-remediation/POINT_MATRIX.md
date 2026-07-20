# Punktmatris — Revisionsåtgärder 2026-07-19

Status: ✅ = implementerad och testad. Alla punkter B01–B14, R01–R21, I01–I24,
K01–K16, A01–A10, T01–T05 är behandlade. Kolumnen "Test" pekar på det primära
testet; typecheck/lint/build gäller alla punkter.

Förkortningar: `YE-mig` = `supabase/migrations/20260716120000_year_end_atomic_close.sql`,
`SIE-mig` = `…130000_sie_import_provenance_engine.sql`,
`Bank-mig` = `…140000_bank_import_rows_sync_status_rls.sql`,
`ÅR-mig` = `…150000_arsredovisning_submission_narrative_hardening.sql`,
`Bucket-mig` = `…160000_bank_files_bucket.sql`.

## B — Bokslut och valutaomvärdering

| ID | Status | Lösning | Ändrade filer (huvudsakliga) | DB-ändring | Test |
|---|---|---|---|---|---|
| B01 | ✅ | Hela bokslutet (readiness → FX → stängningsverifikation → lås/stäng → nästa period → IB → kontinuitet → run-logg) körs i EN transaktion i `execute_year_end_closing` med advisory lock | `lib/core/bookkeeping/year-end-service.ts`, `app/api/bookkeeping/fiscal-periods/[id]/year-end/route.ts` | YE-mig | `year-end-atomic-close.pg.test.ts` "closes the period atomically" |
| B02 | ✅ | Best-effort-storno borttagen; fel ⇒ full transaktionsrollback — perioden är helt öppen eller helt stängd | `year-end-service.ts` (safeReverse borttagen) | YE-mig (RPC) | pg-test "a failing close leaves the books completely untouched" |
| B03 | ✅ | `year_end_db_blockers()` körs INNE i den låsta transaktionen; direkt/parallell POST kan inte kringgå blockerare | YE-mig, `readiness-aggregator.ts` (samma funktion) | YE-mig | pg-test "readiness runs INSIDE the transaction" |
| B04 | ✅ | Aggregatorn failar stängt: RPC-fel, recon-fel, gap-RPC-fel, draft-queryfel ⇒ blockerare med namn+förklaring+checkCompleted | `lib/bokslut/readiness-aggregator.ts`, `year-end-service.ts` | — | `readiness-aggregator.test.ts` fail-closed-fall |
| B05 | ✅ | Deterministisk snapshot-nyckel (sha256 över underlag); `post_currency_revaluation` återanvänder identisk körning, ersätter kontrollerat vid ändrat underlag, vägrar låst period | `lib/bookkeeping/currency-revaluation.ts` | YE-mig (`currency_revaluation_runs` + unikt index) | pg-test "same snapshot key reuses…different key replaces"; unit snapshot-key-tester |
| B06 | ✅ | Historisk rekonstruktion per balansdag: fakturadatum, betalningar ≤ balansdag, kreditnotor, avskrivningar; skapade-efter exkluderas, betalda-senare ingår med historiskt belopp | `lib/invoices/historical-open-items.ts` | `currency_revaluation_items` snapshot | `currency-revaluation.test.ts` (created-after/paid-after/partial) |
| B07 | ✅ | Endast kvarvarande öppet belopp omvärderas, symmetriskt för kund/leverantör | `currency-revaluation.ts` (open_amount, inte total) | — | unit "partially paid invoice revalues only the open amount" |
| B08 | ✅ | Deterministisk reversering i nästa period (dag 1) med `currency_revaluation_reversal`, exakt en gång per körning (`reversal_entry_id`-vakt) | YE-mig (§ reversal i close-RPC) | source_type + kolumn | pg-test atomic close (reversal skapas); revaluation-run-länkning |
| B09 | ✅ | Advisory lock + `year_end_runs` med idempotensnyckel + unika partiella index (en posted year_end/OB per period); andra anropet får idempotent svar eller `YE_ALREADY_CLOSED` | YE-mig; route tar `Idempotency-Key`-header | YE-mig | pg-test "two concurrent closes yield exactly one…"; "replays idempotently" |
| B10 | ✅ | `year_end_runs`-statusmaskin (closing/closed/failed/superseded), GET `/year-end/runs`, wizard-banner för misslyckade körningar med säker retry; atomiciteten gör halvstängda lägen omöjliga | `app/api/.../year-end/runs/route.ts`, `app/(dashboard)/bookkeeping/year-end/page.tsx` | YE-mig | pg-tester (run-rader); feature-policy-check |
| B11 | ✅ | `year_end_db_blockers` returnerar exakta totalantal (`detail_count`) per periodavgränsad kontroll; `.limit(5)`-mönstret borttaget | `readiness-aggregator.ts` (blockerDetails) | YE-mig | `readiness-aggregator.test.ts` |
| B12 | ✅ | Strikt `is_reconciled` (A02) används av readiness; obokförda banktransaktioner i perioden är blockerare i DB-funktionen | `readiness-aggregator.ts`, `bank-reconciliation.ts` | YE-mig | recon-strictness-test + aggregatortest |
| B13 | ✅ | `companies.entity_type` kanonisk (NOT NULL + CHECK); `getCompanyEntityType()` utan AB-fallback kastar vid saknat värde; spegel-trigger håller `company_settings` synkad; alla bokslut/skatt/rapport/fakturamoduler läser kanoniskt | `lib/company/entity-type.ts` + 8 moduler | ÅR-mig (`company_entity_type()`, trigger, backfill) | `arsredovisning-hardening.pg.test.ts`; `result-appropriation.test.ts` (kastar) |
| B14 | ✅ | En kanonisk funktion (`getHistoricalFxExposure`) för öppna/delbetalda/valutafakturor används av omvärdering, readiness (RPC-existenskontroll), AR/AP och rapporter | `historical-open-items.ts`, `currency-revaluation.ts`, recon-rapporter | — | delade tester i currency-revaluation + recon-sviter |

## R — Rapporter, dashboard, årsredovisning

| ID | Status | Lösning | Filer | DB | Test |
|---|---|---|---|---|---|
| R01 | ✅ | Resultatrapporten exkluderar stängningsverifikationen (`excludeYearEndClosing: true`) — samma princip som formella RR; gäller JSON/UI/PDF/XLSX/dashboard/API (alla via samma generator) | `lib/reports/resultatrapport.ts` | — | `resultatrapport.test.ts` post-closing = pre-closing |
| R02 | ✅ | Vald delperiod visar periodens RÖRELSE (`period_credit − period_debit`), aldrig ackumulerad closing | `resultatrapport.ts` | — | "March sub-range shows only that month's movement" |
| R03 | ✅ | Jämförelseår i K2- och K3-PDF (RR + BR + summarader) från samma generatorer/perioddefinitioner som iXBRL | `build-data.ts`, båda PDF-mallarna, `types.ts` | — | `arsredovisning-k3-pdf.test.ts` prior-kolumn |
| R04 | ✅ | Verkliga undertecknare från kanoniska signaturmodellen med roll/namn/datum/status; tomma standardpersoner borttagna; varning när ingen registrerats | `build-data.ts`, PDF-mallar | (befintlig signaturtabell) | PDF-test + unit-fixturer |
| R05 | ✅ | Gemensam totalsummekontroll: `buildIxbrlInput` blockerar när PDF-underlag och iXBRL-mappning divergerar (årets resultat, balansomslutning); preflight/submission delar mappningen. Full radnivåunifiering av PDF-layouten dokumenterad som känd begränsning | `lib/bokslut/ixbrl/build-input.ts` | — | typecheck + ixbrl-tester; kontrollen kastar vid divergens |
| R06 | ✅ | 21xx (obeskattade reserver) exkluderade ur eget-kapital-tabellen | `build-data.ts` `buildEquityChanges` | — | build-data-tester |
| R07 | ✅ | K3 förändring av eget kapital beräknas från verkliga GL-händelser (nyemission 2081–84/2097, utdelning 2091/2098 via result_appropriation, aktieägartillskott 2093, övriga) — inga hårdkodade nollor | `build-data.ts` `buildK3EquityChangesStatement`, `k3-noter-builder.ts` | — | K3-PDF/noter-tester |
| R08 | ✅ | K3 utan kassaflödesanalys ⇒ hårt fel som blockerar dokumentet | `build-data.ts` | — | K3-test (throw) |
| R09 | ✅ | Flerårsöversiktsfel ⇒ `data_missing: true` + varning + blockerar slutlig PDF — aldrig fabricerade nollor | `build-data.ts`, `types.ts`, PDF-route | — | PDF-route-blockerare |
| R10 | ✅ | Standardtexter spåras som `unconfirmed_defaults`; aktiv bekräftelse = spara narrativ ⇒ append-only `arsredovisning_narrative_confirmations` (vem/när/version/text/år); slutlig PDF blockeras tills bekräftat | `narrative-service.ts`, `build-data.ts`, PDF-route | ÅR-mig | `arsredovisning-hardening.pg.test.ts` append-only |
| R11 | ✅ | UTKAST-vattenstämpel + rubrikmärkning på alla sidor; `?final=true` blockeras med blockeringslista (period ej stängd, data_missing, obekräftade texter, inga undertecknare) | PDF-route + båda mallarna | — | PDF-render-tester (draft/final) |
| R12 | ✅ | K3 digital inlämning uttryckligen blockerad med strukturerad kod `K3_DIGITAL_SUBMISSION_NOT_SUPPORTED` (422); PDF-flödet intakt; begränsningen dokumenterad | ixbrl + validate-routes, SYNC_AND_VERIFY §7 | — | route-mappning |
| R13 | ✅ | iXBRL-download OCH preview kör obligatorisk preflight; kritiska fel ⇒ 422 med strukturerade issues (aldrig bara header-antal) | `ixbrl/route.ts` | — | preflight-gating (422-detaljer) |
| R14 | ✅ | Arkiveringsfel BLOCKERAR inlämning (`BOLAGSVERKET_ARCHIVE_FAILED`); payload-hash + deterministisk idempotensnyckel persisteras; partiellt unikt index mot dubbla aktiva inlämningar; state machine + arkiv-dokumentkoppling | `submission-service.ts` | ÅR-mig | `submission-service.test.ts` (inverterat arkivfall, hash/nyckel); pg-idempotenstest |
| R15 | ✅ | Dashboard-YTD utgår från aktiv räkenskapsperiod (stöder brutet år) | `app/(dashboard)/app/page.tsx` | — | typecheck + build; resultatmotorns egna tester |
| R16 | ✅ | Dashboardens resultat från `generateResultatrapport` (samma motor som formella rapporten), klass 3–8 inkl. klass 8; KPI-definition dokumenterad i koden (nettoresultat inkl. finansiella poster) | `app/page.tsx` | — | resultatrapport-tester (delad motor) |
| R17 | ✅ | Ingen rå journalrads-query med defaultgräns — allt via paginerad trial balance i rapportmotorn | `app/page.tsx` | — | `pagination-2500.test.ts` (motorn) |
| R18 | ✅ | Obetald kundfordran = `remaining_amount` över alla öppna statusar (sent/overdue/partially_paid/disputed/collection_ready), kredit/avskrivet korrekt | `app/page.tsx` | — | historisk-open-items-tester |
| R19 | ✅ | Bankkonton dedupliceras per IBAN/uid över (åter)anslutningar; saldodatum + stale-flagga (>48h) visas | `app/page.tsx`, `DashboardContent.tsx` | — | typecheck/build + UI-render |
| R20 | ✅ | Query-fel per KPI ⇒ "kunde inte laddas"-fel i kortet — aldrig 0 kr | `app/page.tsx`, `DashboardContent.tsx` | — | UI-felrendering |
| R21 | ✅ | `lib/dates/stockholm.ts` (Europe/Stockholm-kalenderdatum) används för dashboard/perioddatum; DB-readiness använder `now() AT TIME ZONE 'Europe/Stockholm'` | ny modul + `app/page.tsx` + YE-mig | YE-mig | year_end_db_blockers datumlogik |

## I — SIE-import/-export

| ID | Status | Lösning | Filer | DB | Test |
|---|---|---|---|---|---|
| I01–I03 | ✅ | Vouchers stagas och bokförs av `finalize_sie_import` (samma valideringar som motorn: period, konto, företag, debet/kredit, balans, sekventiella nummer, posted först efter kontroll, revisionsmetadata). Deferred DB-vakt gör tom/obalanserad posted-post omöjlig även vid direktinsert | `sie-staging.ts`, `sie-import.ts` | SIE-mig (RPC + trigger) | `sie-import-engine.pg.test.ts` + "direct INSERT … fails at commit" |
| I04 | ✅ | Proveniens per post: `sie_import_id` FK + `external_reference` (serie:nummer:datum) + källserie/nummer; unikt index per (import, extern nyckel) | SIE-mig | SIE-mig | pg-test provenance + unique |
| I05 | ✅ | Staging med PK (import, row_index) ⇒ idempotent återkörning; finalize hoppar redan bokförda referenser; status/checkpoint/räknare på sie_imports | `sie-staging.ts` | SIE-mig | pg-test "idempotent retry skips…" |
| I06 | ✅ | Replace sker INNE i finalize-transaktionen: nya filen validerad + bokförd innan gamla raderas; fel ⇒ gamla orörd | `sie-import.ts` (replaces_import_id) | SIE-mig | pg-test "FAILING replace leaves the old import intact" |
| I07 | ✅ | IB kopplas till `sie_import_id`; replace/undo raderar exakt importens IB (pekare frigörs bara för egen kedja) | SIE-mig `__sie_delete_import_entries` | SIE-mig | pg-replace/undo-tester |
| I08 | ✅ | `replace_sie_import`/`undo_sie_import`: auth.uid()-kontroll (owner/admin), tenantverifiering, `SET search_path`, REVOKE PUBLIC/anon + minimala grants | SIE-mig | SIE-mig | `bank-import-rows-rls.pg.test.ts` viewer-RPC-fall |
| I09 | ✅ | Undo raderar ENDAST vald imports poster (via sie_import_id); legacy-fallback vägrar om annan completed import delar perioden | SIE-mig | SIE-mig | pg-test "deletes ONLY the chosen import" |
| I10 | ✅ | FK `journal_entries.sie_import_id` + deterministisk backfill (endast entydiga perioder); fil/körning/verifikation/tidpunkt/ersatt spårbart | SIE-mig | SIE-mig | pg-tester |
| I11 | ✅ | Gemensam finalize/statusmaskin (pending/validating/staged/importing/partial/completed/failed/replaced/undone); inga tidiga returns lämnar pending — alla felvägar går via `finalizeImportRecord` → `complete_sie_import` | `sie-import.ts` | SIE-mig | unit + pg statusflöden |
| I12 | ✅ | N→N+1-IB-synk flyttad in i finalize (den gamla döda koden borttagen): fungerar när nästa period finns/skapas/har egen IB från samma kedja; annan källa ⇒ konflikt; kontinuitet exakt 0 annars rollback | SIE-mig | SIE-mig | `sie-import-derived-ib.test.ts` + pg-kontinuitet |
| I13 | ✅ | Execute återvalidear originalfilen server-side: storlek/tomfil/typ + `parseSIEFile` + `validateSIEFile` + hash + periodregler | `app/api/import/sie/execute/route.ts` | — | route-schematester |
| I14 | ✅ | Strikta Zod-scheman (`.strict()`) för options + mappings; okända fält ⇒ tydliga valideringsfel | execute-route | — | route-tester |
| I15 | ✅ | Tyst 1 kr-autojustering borttagen: ≤1 öre auto-3741 (dokumenterad tolerans), (0,01–1,00] kräver `approve_ore_rounding`, >1 kr blockerar eller kräver `approve_skipped_vouchers` | `sie-staging.ts` | — | tolerans-tester 0,01/0,02/1,00/1,50 kr |
| I16 | ✅ | Migrationsjustering endast med uttrycklig `approve_migration_adjustment`; annars varning med exakt differens och rekommendation | `sie-import.ts` | — | unit-tester |
| I17 | ✅ | Statusfinalisering via `complete_sie_import` med felkontroll; API svarar aldrig success om status inte kunde sparas | `sie-import.ts` finalizeImportRecord | SIE-mig | unit + pg |
| I18 | ✅ | Arkivera-först-policy: completed KRÄVER arkiverad originalfil (DB-vakt `SIE_ARCHIVE_REQUIRED`); arkivfel ⇒ `partial` + archive_error (blockerar bokslut via readiness) | finalizeImportRecord + SIE-mig | SIE-mig | pg-test "refuses completed without archive" |
| I19 | ✅ | `#KSUMMA` verifieras (CRC-32 per SIE-spec §7 på råbytes); mismatch blockerar om inte `ignore_ksumma_mismatch` uttryckligen sätts | `lib/import/sie-ksumma.ts` | ksumma-kolumner | ksumma-verifiering i executeSIEImport-tester |
| I20 | ✅ | Export levererar äkta CP437/PC8-bytes (å/ä/ö byte-för-byte-testade); `#FORMAT PC8` är nu sanningsenlig | `sie-export.ts` `encodeSieToPc8`, båda routes | — | byte-för-byte-test + API-test (0x94 för ö) |
| I21 | ✅ | Paginerad hämtning av verifikationer/rader; 2 500-verifikationstest verifierar alla `#VER`/`#TRANS`/`#RES` | `sie-export.ts` | — | `pagination-2500.test.ts` |
| I22 | ✅ | Fullständiga `#DIM`/`#OBJEKT` även för icke-standarddimensioner från jsonb; rundgång behåller metadata | `sie-export.ts` | — | export-dimensionstester |
| I23 | ✅ | Fel vid föregående års data ⇒ exporten blockeras med tydligt fel (aldrig till synes giltig fil med fel `RAR -1`/`UB -1`/`RES`) | `sie-export.ts` | — | fail-closed-tester |
| I24 | ✅ | `complete_sie_import` persisterar SAMMA slutliga varningslista som API-svaret, efter att alla parser-/validerings-/bokföringsvarningar är kända | finalizeImportRecord | SIE-mig (warnings-kolumn) | unit |

## K — Bankfilimport och banksynk

| ID | Status | Lösning | Filer | DB | Test |
|---|---|---|---|---|---|
| K01 | ✅ | `auto_categorize:false` ⇒ `disableAutomation` genom hela ingest (ingen kategorisering/matchning/bokföring); flaggan valideras + persisteras i `bank_file_imports.options` | execute-route, `ingest.ts` | Bank-mig | ingest-test "disableAutomation runs no automation" |
| K02 | ✅ | `skip_duplicates:true` ⇒ hoppas+rapporteras (radstatus duplicate); `false` ⇒ importen blockeras med dubblettlista | execute-route | Bank-mig | route-flöde + ingest-radresultat |
| K03 | ✅ | Parse arkiverar originalfilen (`bank-files`-bucket, WORM); execute laddar ned, räknar om hash, parsar server-side — klientens transaktionslista ignoreras | parse/execute-routes | Bucket-mig + `file_storage_path` | route-verifiering (hash-mismatch avvisas) |
| K04 | ✅ | `bank_file_import_rows` med stabil radnyckel + status (pending/imported/duplicate/failed); partial ≠ completed; retry behandlar endast pending/failed rader | execute-route | Bank-mig | `bank-import-rows-rls.pg.test.ts` unikhet + statusmaskin |
| K05 | ✅ | Kanonisk proveniens: radnyckel = deterministiskt external_id; import_source/counterparty-fält typade; status-CHECK i DB | ingest + Bank-mig | Bank-mig | pg status-CHECK-test |
| K06 | ✅ | Dedup failar stängt (queryfel ⇒ abort, aldrig "inga dubbletter"), paginerad över historiken, tenant + kontoskopad, unikt DB-index (company, external_id) som sista försvarslinje | `ingest.ts` | (befintligt unikt index) | ingest fail-closed-tester |
| K07 | ✅ | Saknad 19xx-mappning blockerar automatisk bokföring: `mapping_required`-räknare + `automation_status='needs_review'`; ingen fallback till godtyckligt konto för PSD2-rader | `ingest.ts` | — | ingest K07-test |
| K08 | ✅ | EN viewer-policy: read-only i både API (requireWrite på parse+execute; rawInsertOnly-undantaget borttaget) och RLS (`user_can_write_company` på transactions/bank_connections/bank_file_imports/cash_accounts) och RPC:er | routes + Bank-mig | Bank-mig | viewer-RLS-pg-tester |
| K09 | ✅ | Arkiveringsfel för rå PSD2-respons räknas (`archiveErrors`) och gör synken partial — aldrig ren success | `sync.ts` | — | sync-test archiveErrors |
| K10 | ✅ | `Promise.allSettled` per konto även i cron; per-kontostatus/checkpoint/fel i `bank_sync_runs.details`; garanterad finalize | cron-route, index.ts | Bank-mig | accounts-route/sync-tester |
| K11 | ✅ | `initial_sync_completed_at` sätts ENDAST vid helt ren initialsynk (0 radfel, 0 rejected konton) — historikfönstret krymper inte i förtid | cron-route | — | cron-logik + typkontrakt |
| K12 | ✅ | Strikta run-statusar success/partial/failed/auth_required/rate_limited; summeringar överensstämmer med radnivåresultat | sync-run.ts, cron, manuell synk | Bank-mig (CHECK) | statusberäkningstester |
| K13 | ✅ | Metadata-commits felkontrolleras; misslyckad commit ⇒ run failed + `bank_sync.failed`-event — aldrig success-event | cron + manuell synk | — | flödestester |
| K14 | ✅ | Manuell synk inspekterar radnivåresultat även vid fulfilled promise (radfel/arkivfel ⇒ partial) | index.ts | — | sync-resultattester |
| K15 | ✅ | Korrekt intervallsnitt `period_start <= to AND period_end >= from`; queryfel failar stängt (behandlas som överlapp) | index.ts (manuell synk) | — | sync-filter-tester |
| K16 | ✅ | Automationsfel efter ingest: transaktionen kvar, `automation_status='failed'`, `automation_errors` i resultatet, retry möjlig, ingen dubbelbokning | `ingest.ts` | — | ingest K16-test |

## A — Bankavstämning och reskontra

| ID | Status | Lösning | Filer | DB | Test |
|---|---|---|---|---|---|
| A01/A03 | ✅ | Alla bank- och GL-rader paginerade (`fetchAllRows`/range-loop på RPC) i status/auto-match/counts/differenser | `bank-reconciliation.ts` | — | pagination-2500 + recon-tester |
| A02 | ✅ | `is_reconciled` kräver noll differens (öre) OCH 0 omatchade bankrader OCH 0 omatchade GL-rader | `bank-reconciliation.ts` | — | "two offsetting unmatched rows ⇒ not reconciled" |
| A04 | ✅ | Optimistiskt lås (`.is('journal_entry_id', null)` + radräkning) i auto- och manuell matchning; concurrent förlorare avbryts utan orphan | `bank-reconciliation.ts` | — | concurrent-claim-tester |
| A05 | ✅ | Manuell matchning verifierar företag, bankkonto, belopp, riktning, valuta (SEK-jämförbar), datumtolerans (±90 d); avvikelse kräver uttryckligt `allow_amount_mismatch`-differensflöde | `bank-reconciliation.ts`, link-route, schema | — | A05-avvisningstester |
| A06 | ✅ | AR/AP-avstämning jämför historiskt öppet reskontrasaldo per datum mot GL:s CLOSING-saldo (IB+rörelser) per samma datum | `ar-reconciliation.ts`, `supplier-reconciliation.ts` | — | as-of-tester |
| A07 | ✅ | Reskontra/avstämning paginerade; 2 500-poststest | recon + ledgers | — | `pagination-2500.test.ts` |
| A08 | ✅ | FX/delbetalningsdifferensen LÖST: subledger + persisterade orealiserade omvärderingsjusteringar (`currency_revaluation_items`) = omvärderat GL-saldo; "known divergence"-kommentaren borttagen | recon-rapporter | YE-mig (items) | fx_revaluation_adjustment-tester |
| A09 | ✅ | `asOfDate` rekonstruerar historiskt öppna fakturor + restbelopp (betalningar/krediteringar efter datumet exkluderas); aging från snapshoten | `ar-ledger.ts`, `supplier-ledger.ts` | — | historisk-aging-tester |
| A10 | ✅ | DB-fel ⇒ strukturerat throw — aldrig tom nollreskontra | ledgers + recon | — | throw-on-error-tester |

## T — Kvalitet, test, leverans

| ID | Status | Lösning | Filer | Test/verifiering |
|---|---|---|---|---|
| T01 | ✅ | 203 lintfel fixade (set-state-in-effect, static-components, preserve-manual-memoization, immutability, refs, purity, no-explicit-any, prefer-const, no-require-imports); baseline = 0; enda undantag: dokumenterad `.cjs`-override + repo-etablerade exhaustive-deps-mönstret | ~100 filer, `eslint.config.mjs`, `eslint-baseline.json` | `npm run lint` (0 fel), `npm run check:lint` grön |
| T02 | ✅ | `npm run test:pg` fungerar: pg-real-projektet alltid registrerat, `scripts/pg-test-db.sh` bygger färsk DB från ALLA migreringar (Supabase-image ELLER ren Postgres via `tests/pg/bootstrap-plain-postgres.sql`); sviten täcker RPC/triggers/constraints/RLS/grants/tenantisolering/concurrency/idempotens/rollback/migrationsordning | `vitest.config.ts`, `scripts/pg-test-db.sh`, bootstrap | 76 pg-testfiler gröna mot färsk DB |
| T03 | ✅ | `tsx@4.23.1` låst devDependency; `npx tsx` löser lokalt utan näthämtning | `package.json` | `npx tsx --version` |
| T04 | ✅ | `NODE_OPTIONS=--max-old-space-size=4096` i build-scriptet (gäller lokalt/CI/Vercel som kör `npm run build`); ingen manuell miljövariabel krävs | `package.json` | `npm run build` grön |
| T05 | ✅ | `middleware.ts` → `proxy.ts` med `export function proxy` (Next.js 16-konvention); beteendet oförändrat (logiken bor kvar i `lib/supabase/middleware.ts`) | `proxy.ts` | build grön; matcher intakt |
