# Nordklart — full system- och konsistensgranskning

**Datum:** 2026-08-06  
**Repository:** `heke99/nordklart`  
**Granskad baseline:** `main` vid commit `a8dee572969d37295b714460bf326d386e39f673`  
**Auditbranch:** `audit/nordklart-system-consistency-2026-08-06`  
**Ändringar i produktionskod:** Inga

## 1. Sammanfattning

Nordklart har en starkare ekonomisk kärna än många SaaS-system i motsvarande fas. De senaste migrations- och serviceändringarna innehåller genomtänkta barriärer för journalintegritet, tenantisolering, idempotens, service-role-avgränsning, periodkontroll och atomisk uppdatering av betalningsrelaterade poster.

Systemet kan däremot **inte ännu beskrivas som fullt konsekvent eller fullständigt produktionsverifierat**. Den största risken är inte en enskild uppenbar TypeScript-bugg, utan skillnaden mellan:

1. vad arkitekturen och dokumentationen säger att systemet garanterar,
2. vad den aktuella CI-kedjan faktiskt tvingar igenom på `main`,
3. vad de riktiga PostgreSQL-testerna faktiskt täcker, och
4. vad som är verifierat i den verkliga Nordklart-databasen.

### Samlad bedömning

| Klass | Antal |
|---|---:|
| Bekräftad kritisk | 0 |
| Bekräftad hög | 6 |
| Bekräftad medel | 6 |
| Bekräftad låg | 2 |
| Hög risk som kräver verifiering | 1 |
| Kända produkt-/verifieringsgap | Flera |

### Produktionsbeslut

**Bedömning: villkorad stop-ship för finansiellt kritiska ändringar.**

Nordklart bör inte göra anspråk på full finansiell atomicitet, full migrationssäkerhet eller full bokslutsverifiering förrän fynd H-01–H-06 är åtgärdade och kontrollerade mot en riktig Supabase/PostgreSQL-miljö.

Detta betyder inte att systemet är trasigt överallt. Det betyder att de viktigaste garantierna ännu inte är tillräckligt bevisade för att man ska kunna förlita sig på gröna deploy-statusar som kvalitetsbevis.

---

## 2. Granskningsmetod och begränsningar

Granskningen har omfattat:

- repositorystruktur och projektinstruktioner,
- samtliga 41 installerade projekt-skills,
- `.agent-memory`,
- GitHub Actions och statuskontroller,
- senaste relevanta commits,
- finansiell härdningsrapport,
- migration `20260801140000_production_financial_atomicity_and_billing_lifecycle.sql`,
- kund- och leverantörsbetalningsflöden,
- journal- och bankallokeringsbarriärer,
- Stripe-/engångsköpsrelaterade databaskontrakt,
- bokslutsaccess,
- migrationsrunner,
- unit- och pg-real-testernas faktiska omfattning,
- skill-supply-chain och spårbarhet.

### Begränsningar

- Ingen Nordklart-Supabase-instans var ansluten till den tillgängliga Supabase-connectorn.
- Ingen livekontroll kunde därför göras av migrationsdrift, RLS-policyer, security/performance advisors, grants, dubbletter eller produktionsdata.
- Koden har inte körts lokalt i denna connectorbaserade granskning.
- Resultatet skiljer därför strikt mellan **bekräftade repositoryfynd**, **sannolika risker** och **ej verifierade produktionsförhållanden**.

---

## 3. Starka kontroller som redan finns

Följande är tydliga styrkor och ska bevaras:

1. **Postade journalposter skyddas mot mutation.** Migrationen innehåller barriärer som blockerar ändring av postade verifikat och rader.
2. **Finansiella RPC:er är service-role-avgränsade.** Relevanta funktioner återkallar åtkomst för `PUBLIC`, `anon` och `authenticated` och ger endast `service_role` exekveringsrätt.
3. **`SECURITY DEFINER`-funktioner har pinad `search_path`.** Detta minskar risken för object-shadowing.
4. **Idempotens lagras i databasen.** Betalnings- och Stripeflöden har idempotensposter och advisory locks.
5. **Tenant- och aktörskontroller finns i kritiska RPC:er.** Skrivbehörighet löses före ekonomiska mutationer.
6. **Outbox används för hållbara sidoeffekter.** Det är rätt riktning jämfört med att enbart lita på omedelbara event.
7. **Reparationsflödet kräver verklig aktör och motivering.** Det har dry-run/apply, advisory lock och audit trail.
8. **Riktiga PostgreSQL-tester finns.** Workflowen startar en PostgreSQL/Supabase-liknande container och applicerar migrationer med `psql`.
9. **Koden har separata guards för arkitektur, RLS, journalintegritet och extension-boundaries.**
10. **Projektets `AGENTS.md` beskriver tydliga invariants.** Problemet är främst enforcement och aktualitet, inte frånvaro av avsikt.

---

# 4. Bekräftade fynd

## H-01 — `main` kan deployas utan att kärn- och pg-real-verifieringen körs

**Allvar:** Hög  
**Status:** Bekräftad

### Evidens

- `.github/workflows/core-build.yml` triggas endast av `pull_request`.
- `.github/workflows/test-pg-real.yml` triggas endast av `pull_request`.
- Senaste commit på `main` hade gröna Railway- och Vercel-statusar men inga GitHub Actions-körningar för core-build eller pg-real.
- Den stora produktionshärdningscommitten hade samma mönster.
- Repositoryt hade inga öppna pull requests vid granskningen.

### Konsekvens

En direkt push till `main` kan nå deployment trots att följande inte har bevisats för committen:

- typecheck,
- lint/ratchet,
- unit tests,
- arkitekturguards,
- samtliga migrationer mot riktig PostgreSQL,
- pg-real-tester.

En lyckad Vercel- eller Railway-deploy visar bara att respektive deploymentprocess lyckades. Den visar inte att Nordklarts finansiella invariants är intakta.

### Åtgärd

1. Kör `core-build` och `test-pg-real` även på `push` till `main`.
2. Inför branch protection/ruleset där båda är obligatoriska checks före merge.
3. Blockera direktpush till `main` för normala utvecklarflöden.
4. Använd environment protection för produktion så att deploy endast får ske från verifierad commit.
5. Lägg till concurrency/cancel-in-progress för att undvika parallella gamla verifieringar.

### Acceptanskriterium

Ingen commit kan bli produktionsdeployad utan att samma SHA har passerat båda verifieringskedjorna.

---

## H-02 — Den verkliga Nordklart-databasen är inte verifierad mot repositoryt

**Allvar:** Hög  
**Status:** Bekräftat verifieringsgap

### Evidens

- Ingen Nordklart-Supabase-instans var tillgänglig i den anslutna Supabase-connectorn.
- `.agent-memory` beskriver tidigare migrationer som parser-/byggverifierade men inte applicerade mot live eller produktionslik databas.
- Repositoryt innehåller hundratals migrationer och ett eget migrationsregister, vilket gör driftkontroll extra viktig.

### Konsekvens

Det går inte att fastställa att produktion faktiskt har:

- samma migrationsmängd och checksums som `main`,
- korrekta RLS-policyer,
- rätt grants och function ownership,
- rätt extension-schema,
- inga gamla dubbletter i bankallokeringar,
- inga stale invoice aggregates,
- inga säkerhets- eller prestandavarningar,
- samma RPC-signaturer som applikationskoden förväntar sig.

### Åtgärd

Kör en separat, read-only produktionsverifiering:

1. exportera faktisk migrationsstatus och checksums,
2. jämför mot repositoryt,
3. kontrollera `pg_proc`, `proconfig`, owners och grants,
4. kör Supabase security- och performance-advisors,
5. kör RLS-negativtester med minst två tenants,
6. kör discrepancy-vyerna,
7. verifiera pgcrypto och extension-schema,
8. verifiera att PostgREST ser rätt RPC-signaturer.

### Acceptanskriterium

En signerad/driftspårbar rapport visar noll oförklarad schema- eller migrationsdrift mellan produktion och en namngiven Git-commit.

---

## H-03 — Betalningsflödet är inte fullt atomiskt från första ekonomiska objektet

**Allvar:** Hög  
**Status:** Bekräftad

### Evidens

`lib/invoices/mark-paid-service.ts` skapar/stagar ett draft-verifikat och dess rader innan den atomiska settlement-RPC:n körs. Om RPC:n misslyckas försöker servicekoden kompensera genom att markera draften som avbruten. Om även den städningen misslyckas loggas felet, men draften kan finnas kvar.

`PRODUCTION_HARDENING_REPORT.md` beskriver själv detta som en kvarvarande avvikelse från strikt atomicitet.

### Konsekvens

- Ett avbrutet nätverksanrop, timeout eller servicefel kan lämna orphan drafts.
- Databasen kan vara ekonomiskt korrekt i postade poster men ändå innehålla operativt missvisande draftdata.
- Retries kan bli svårare att analysera eftersom idempotensresultatet och draftens livscykel inte ligger i samma transaktion.
- Support och reparationsverktyg måste förstå delvis skapade objekt.

### Åtgärd

Flytta följande till en enda databaskontrollerad transaktion/RPC:

1. skapa draft entry,
2. skapa lines,
3. validera balans och period,
4. posta entry,
5. skapa betalning,
6. uppdatera invoice aggregate/status,
7. skapa banklänk,
8. audit/outbox/idempotens.

Alternativt ska det finnas ett explicit state machine-kontrakt för reserverad draft med obligatorisk återhämtning och en worker som deterministiskt städar orphan drafts.

### Acceptanskriterium

Failure injection efter varje delsteg lämnar antingen hela affärshändelsen committed eller ingen ekonomisk/draftmässig rest alls.

---

## H-04 — Historiska dubbletter i bankallokering kan överleva härdningsmigrationen

**Allvar:** Hög  
**Status:** Bekräftad

### Evidens

Migration `20260801140000_production_financial_atomicity_and_billing_lifecycle.sql` skapar unika index för bankallokering endast när data redan är ren. Om dubbletter finns skapas i stället review-index och triggers som förhindrar nya dubbletter.

### Konsekvens

- Gamla dubbla länkar kan ligga kvar permanent.
- Nya skrivningar skyddas, men historiska invoice/payment totals kan redan vara fel.
- Discrepancy-vyer kan upptäcka tillståndet, men de gör inte automatiskt datan korrekt.
- En migration kan rapporteras som lyckad trots att den ekonomiska invariant den avser ännu inte gäller för all data.

### Åtgärd

1. Gör en obligatorisk preflight som räknar och listar dubbletter.
2. Stoppa produktionsaktivering eller isolera berörda poster i en explicit remediation queue.
3. Reparera med aktör, orsak, audit trail och reversibla checkpoints.
4. Skapa därefter ovillkorliga unika constraints/index.
5. Lägg till ett startup/health-check som misslyckas om constrainten saknas.

### Acceptanskriterium

Databasen har ovillkorliga unika constraints och discrepancy-vyerna rapporterar noll historiska dubbletter.

---

## H-05 — Testbevisningen är smalare än produktionspåståendena

**Allvar:** Hög  
**Status:** Bekräftad

### Evidens

`lib/core/bookkeeping/__tests__/financial-hardening-migration.test.ts` verifierar huvudsakligen att vissa SQL-fragment finns som text.

`lib/core/bookkeeping/__tests__/financial-atomicity.pg.test.ts` verifierar i huvudsak:

1. att postad journal inte kan ändras till cancelled,
2. att grants/search_path ser rätt ut,
3. att en ogiltig settlement rullas tillbaka utan idempotensrest.

Den verifierar inte hela den matris som härdningsrapporten och migrationen avser.

### Saknade kritiska scenarier

- lyckad full kundbetalning,
- lyckad delbetalning,
- lyckad leverantörsbetalning,
- överbetalning,
- två samtidiga anrop med samma idempotensnyckel,
- två samtidiga bankallokeringar,
- timeout efter commit men före HTTP-svar,
- retry efter timeout,
- fel efter draftskapande,
- fel efter journalpostning men före invoice update,
- Stripe-event i fel ordning,
- duplicerat Stripe-event,
- refund/dispute/chargeback,
- engångsköp bundet till exakt räkenskapsperiod,
- RLS-negativtest tenant A mot tenant B,
- reparationsflöde dry-run/apply/failure,
- migration från databas som redan innehåller historiska avvikelser.

### Konsekvens

Koden kan innehålla korrekta skydd utan att regressioner upptäcks. Dokumentationen riskerar att tolkas som att alla centrala egenskaper är körda och bevisade, när endast delar är det.

### Åtgärd

Skapa en spårbar verification matrix där varje produktionsgaranti pekar på:

- exakt testfil,
- exakt testnamn,
- miljö,
- positivt scenario,
- negativt scenario,
- concurrency/failure-injection där relevant.

### Acceptanskriterium

Varje påstående i `PRODUCTION_HARDENING_REPORT.md` är antingen verifierat av ett körbart test eller märkt som designad men ännu ej verifierad.

---

## H-06 — Dubbla migrationstimestamps skapar två migrationssanningar

**Allvar:** Hög  
**Status:** Bekräftad

### Evidens

Projektminnet dokumenterar flera migrationer med samma numeriska timestamp, bland annat versionerna `20260629120000` och `20260704120000`.

Det egna scriptet `scripts/supabase-migrate.cjs` lagrar hela filnamnet i `nordklart_schema_migrations`, vilket gör att det kan skilja filerna åt. Native Supabase tooling identifierar däremot normalt migrationer genom versionsprefixet.

### Konsekvens

- Egen runner och Supabase CLI kan rapportera olika status.
- `db push`, repair eller driftkontroll kan bli tvetydig.
- En utvecklare kan tro att en migration är applicerad när endast den andra med samma prefix är det.
- Framtida incidentanalys får en oklar schemahistorik.

### Åtgärd

Eftersom redan distribuerade migrationer inte ska skrivas om retroaktivt:

1. dokumentera en kanonisk ordning och checksum-mappning för kollisionerna,
2. lägg till CI-guard som förbjuder nya duplicerade timestamps,
3. lägg till driftkontroll som jämför både fulla filnamn och Supabase-versioner,
4. skapa en engångsreconciliation för alla miljöer,
5. besluta och dokumentera vilken runner som är enda produktionssanning framåt.

### Acceptanskriterium

Alla miljöer visar samma deterministiska migrationsordning och CI blockerar varje ny timestampkollision.

---

## M-01 — `.agent-memory` är inaktuellt och motsäger aktuell kod

**Allvar:** Medel  
**Status:** Bekräftad

### Evidens

- Minnet beskriver migrationer till omkring 424, medan repositoryt innehåller senare härdning.
- `next-actions.md` säger fortfarande att återstående atomiskt betalningsflöde ska implementeras och att migration 424 inte ska aktiveras.
- Den stora härdningscommitten och migration 426 finns redan på `main`.

### Konsekvens

Nästa agent kan:

- återimplementera redan byggd funktionalitet,
- fatta beslut från gammal migrationsstatus,
- missa nya risker,
- ge användaren felaktig status.

### Åtgärd

Uppdatera `current-state.md`, `open-blockers.md`, `next-actions.md`, `verification.md` och `changes.md` i samma PR som varje större arkitekturändring. Lägg till CI som varnar när kärnfiler/migrationer ändras utan motsvarande memory-update.

---

## M-02 — Skill-supply-chain saknar full proveniens

**Allvar:** Medel  
**Status:** Bekräftad

### Evidens

- `.agents/SKILLS_LOCK.sha256` innehåller 41 låsta skillfiler.
- `.agents/SKILLS_SOURCES.tsv` dokumenterar endast 35.
- Sex skills saknar därmed motsvarande källrad/installationsspårning:
  - `skill-scanner`
  - `deploy-to-vercel`
  - `vercel-cli-with-tokens`
  - `vercel-composition-patterns`
  - `vercel-react-native-skills`
  - `vercel-react-view-transitions`

### Konsekvens

Checksummen kan visa att filen inte ändrats, men inte varifrån den kom, vilken version som importerades eller vilket förtroendeunderlag som användes.

### Åtgärd

Komplettera källregistret och lägg till CI-regel:

`set(SKILLS_LOCK) == set(SKILLS_SOURCES) == set(.agents/skills/*/SKILL.md)`

---

## M-03 — Penningavrundning följer inte projektets kanoniska regel överallt

**Allvar:** Medel  
**Status:** Bekräftad

### Evidens

`AGENTS.md` kräver `roundOre()` för penningbelopp i TypeScript. I `lib/invoices/mark-paid-service.ts` beräknas radbelopp med direkt `Math.round((debit - credit) * 100)`.

Den befintliga guarden verkar främst leta efter ett annat vanligt mönster och kan därför missa denna variant.

### Konsekvens

- Flera avrundningsimplementeringar kan ge olika resultat vid edge cases.
- Guardens gröna resultat bevisar inte att all pengalogik använder samma policy.
- Framtida refactors kan blanda ören och kronor.

### Åtgärd

Använd en enda typad penningmodul och förbjud direkt `Math.round` i finansiella kataloger genom AST-baserad lint/guard.

---

## M-04 — Ingen enda kanonisk verifieringskommando finns

**Allvar:** Medel  
**Status:** Bekräftad

### Evidens

`package.json` har många separata kommandon för typecheck, lint, unit, guards, pg-real, build och migrationer, men inget enda `verify`/`verify:all` som representerar releasebar commit.

### Konsekvens

- Lokala och agentbaserade körningar kan välja olika delmängder.
- Dokumentation kan säga ”allt grönt” utan en enhetlig definition.
- CI-workflows kan drifta från lokala instruktioner.

### Åtgärd

Inför exempelvis:

- `verify:fast` — typecheck, lint, unit, guards,
- `verify:db` — migration apply + pg-real,
- `verify:release` — fast + db + build + schema/contract checks.

CI och release ska anropa samma scripts som utvecklare och agenter.

---

## M-05 — Git-historiken har låg revisionskvalitet

**Allvar:** Medel  
**Status:** Bekräftad

### Evidens

Flera stora commits har meddelanden som `332` eller `3332`. Den stora härdningen låg i en commit vars meddelande inte beskriver ändringens risk, scope eller migrering. Vid granskningen fanns inga öppna issues eller PR:er som bar den aktuella förändringshistoriken.

### Konsekvens

- Incidentanalys och blame blir svårare.
- Det går inte snabbt att förstå varför en migration eller barriär introducerades.
- Krav, risk och verifiering kopplas inte stabilt till ändringen.

### Åtgärd

Kräv PR-baserade förändringar för finansiell kod, conventional/semantiska commitmeddelanden och PR-mall med risk, migration, rollback och testbevis.

---

## M-06 — Produktionshärdningsrapporten blandar implementerat och bevisat

**Allvar:** Medel  
**Status:** Bekräftad

### Evidens

`PRODUCTION_HARDENING_REPORT.md` beskriver ett stort antal garantier som implementerade. Samma dokument listar samtidigt full install/type/lint/unit/build, tom PostgreSQL-installation, produktionslik snapshot, RLS, concurrency och failure injection som återstående arbete.

### Konsekvens

En läsare kan tolka ”implemented” som ”verifierat i releasekedjan”. För ett bokföringssystem måste designstatus, kodstatus, teststatus och live-status vara separata.

### Åtgärd

Märk varje kontroll med fyra separata statusfält:

- Designed
- Implemented
- Automated test passed
- Production verified

---

## L-01 — Bygget har dokumenterat nätverksberoende till Google Fonts

**Allvar:** Låg/medel  
**Status:** Bekräftad i projektminnet

### Konsekvens

Hermetiska eller begränsade CI-miljöer kan misslyckas trots oförändrad produktkod.

### Åtgärd

Self-hosta eller vendora nödvändiga fonts och gör build reproducerbar utan extern hämtning.

---

## L-02 — Deployment- och repo-status används som ersättning för systemhälsa

**Allvar:** Låg/medel  
**Status:** Bekräftad processrisk

Railway/Vercel-status, repositoryguards och textbaserade migrationstester är användbara, men de får inte presenteras som full bokförings-, RLS- eller databasverifiering.

Inför en separat releaseattest som listar exakt vilka lager som verifierats.

---

# 5. Hög risk som måste verifieras omedelbart

## R-01 — Möjlig bypass i bokslutsaccess för iXBRL-feature

**Allvar:** Potentiellt hög  
**Status:** Kodmönster bekräftat, exploaterbar call site ej bekräftad

### Evidens

I `lib/year-end/access.ts` kontrolleras `allowIxbrlFeature` före den kanoniska aktörs-, företags-, period- och skrivrättskontrollen. Om entitlement finns returnerar funktionen access direkt.

Kodkommentaren beskriver dessutom en annan kontrollordning än implementationen.

GitHubs kodindex gav ingen säker träff på ett faktiskt anrop som sätter flaggan, så detta klassas inte som bekräftad behörighetsbypass.

### Risk

Om en route för en exakt fiscal period använder `allowIxbrlFeature: true` kan feature-entitlement i teorin bli en genväg förbi:

- canonical company access,
- exakt periodbindning,
- `requireWrite`.

### Åtgärd

1. Entitlement ska aldrig ersätta actor/company/period-access.
2. Kör alltid canonical capability resolver först.
3. Lägg feature entitlement som ett extra AND-villkor efter access.
4. Lägg negativa tester för fel företag, fel period, read-only user och saknad actor.
5. Sök igenom alla call sites med lokalt index/AST, inte enbart GitHub code search.

---

# 6. Kända funktionella och operativa gap

Följande är dokumenterade i repositoryts eget minne eller härdningsrapport och ska inte räknas som stängda utan nya verifieringsbevis:

1. Full leverantörsregistrering och komplett supplier invoice-livscykel.
2. Kreditnotor, allocation och edge cases för över-/underbetalning.
3. Historisk AR/AP-settlement och bankimport.
4. Specialverktyg utanför standardflöden.
5. Full matris för moms, periodisering, anläggningstillgångar, bokslut och årsredovisning.
6. Klassificering och sanering av gamla cancelled/committed entries.
7. Liveverifiering av engångsköp för exakt räkenskapsperiod.
8. Regressionstäckning för tidigare rapporterade incidenter:
   - `FEATURE_ACCESS_UNAVAILABLE` i Dispositioner,
   - `YEAR_END_FAILED`/`YE_UNKNOWN`,
   - SIE-import utan ansluten bank och manuell verifiering,
   - 404 i bankavstämnings-/bokslutsflöde,
   - pgcrypto/digest och extension-schema,
   - tvetydiga SQL-kolumnreferenser som `open_amount`.

Dessa historiska incidenter är inte automatiskt bekräftade som kvarvarande buggar, men de saknar i den granskade evidensen en sammanhållen regression suite som bevisar att de inte återkommer.

---

# 7. Obligatorisk remediationordning

## Fas 0 — Stoppa nya verifieringsluckor

1. Skydda `main`.
2. Kör core-build och pg-real på PR och push till `main`.
3. Gör checks obligatoriska före deploy.
4. Lägg CI-guard för nya migrationstimestampkollisioner.
5. Lägg CI-guard för skill-proveniens.

## Fas 1 — Bevisa aktuell databas

1. Anslut rätt Nordklart-Supabase-projekt read-only.
2. Kör migration/checksum drift report.
3. Kör security/performance advisors.
4. Kör RLS-negativtester.
5. Kör discrepancy-vyer och dubblettkontroller.
6. Verifiera RPC-signaturer, grants, owners och `search_path`.

## Fas 2 — Slut atomisk ekonomisk transaktion

1. Flytta draftskapande in i den atomiska databastränsen.
2. Lägg concurrency- och timeouttester.
3. Gör failure injection efter varje ekonomiskt delsteg.
4. Bevisa retry efter ”commit men svar förlorat”.

## Fas 3 — Reparera historiska data

1. Dubbletter i banklänkar.
2. Stale invoice aggregates.
3. Orphan/cancelled drafts.
4. Historiska AR/AP-avvikelser.
5. Ovillkorliga constraints efter sanering.

## Fas 4 — Bokslut och engångsköp

1. Ta bort möjlig iXBRL-genväg.
2. Verifiera exakt company + fiscal period + user + write access.
3. Testa Stripe-eventordning, duplicate, refund och dispute.
4. Regressionstesta Dispositioner, SIE utan bank och full year-end execution.

## Fas 5 — Dokumentation och releaseattest

1. Uppdatera `.agent-memory`.
2. Separera designed/implemented/tested/live-verified.
3. Inför `verify:release`.
4. Kräv tydliga PR- och commitbeskrivningar.

---

# 8. Minsta verifieringsmatris före produktionsgodkännande

| Område | Positivt test | Negativt test | Concurrency/failure | Live verifiering |
|---|---|---|---|---|
| Kundbetalning | Full + delbetalning | Överbetalning/fel period | Dubbel request/timeout | Discrepancy = 0 |
| Leverantörsbetalning | Full + delbetalning | Överbetalning/fel företag | Dubbel request/timeout | Discrepancy = 0 |
| Bankallokering | Giltig unik länk | Cross-table duplicate | Samtidiga writers | Unik constraint finns |
| Journal | Postning/reversal | Mutation av posted | Samtidig postning | Inga orphan entries |
| Stripe engångsköp | Betald session | Fel metadata/period | Duplicate/out-of-order | Period grant exakt |
| Bokslut | Full körning | Fel period/read-only | Retry/failure step | Audit + balances |
| SIE | Import med/utan bank | Felaktig fil/tenant | Retry | Manuell verifiering fungerar |
| RLS | Tenant A egna data | Tenant A läser/skriver B | Service boundary | Advisors + policy dump |
| Migration | Tom DB | Smutsig snapshot | Restart mitt i apply | Drift = 0 |
| Repair | Dry-run/apply | Saknad actor/reason | Fel mitt i batch | Audit/checkpoint |

---

# 9. Skill-routing — samtliga 41 installerade skills

Alla installerade skill-entrypoints har inventerats. En skill har inte behandlats som ”använd” bara för att den finns; statusen nedan skiljer faktisk granskningslins från villkorlig/icke relevant exekvering.

| Skill | Status | Användning/motivering |
|---|---|---|
| acquire-codebase-knowledge | Aktiverad | Repository-, domän- och invariantkartläggning |
| api-and-interface-design | Aktiverad | RPC/API-boundaries och idempotenskontrakt |
| api-design-principles | Aktiverad | Felkontrakt, actor context och kompatibilitet |
| auth-implementation-patterns | Aktiverad | Company access, write access, service role |
| ci-cd-and-automation | Aktiverad | Workflow triggers och required-check-gap |
| code-review-and-quality | Aktiverad | Evidensbaserad kod- och processgranskning |
| code-review | Aktiverad | Kritiska services, migrationer och tester |
| code-simplifier | Villkorlig | Ingen produktionskod skulle förenklas i auditfasen |
| debugging-and-error-recovery | Aktiverad | Retry, cleanup, orphan drafts och failure paths |
| deploy-to-vercel | Villkorlig | Deploymentstatus analyserad; ingen deploy genomförd |
| deployment-pipeline-design | Aktiverad | Main protection, release gates och environment controls |
| documentation-and-adrs | Aktiverad | Memory-/rapportmotsägelser och attestmodell |
| doubt-driven-development | Aktiverad | Bekräftat vs sannolikt vs ej verifierat |
| e2e-testing-patterns | Aktiverad | Saknade end-to-end-finansiella scenarier |
| error-handling-patterns | Aktiverad | Compensation, sanitized errors och replay |
| find-bugs | Aktiverad | Inkonsekvenser och potentiella felvägar |
| incremental-implementation | Villkorlig | Relevant först i remediationfasen |
| nextjs-app-router-patterns | Aktiverad | Route/service-access och server boundaries |
| nodejs-backend-patterns | Aktiverad | Serviceflöden, retries och outbox |
| observability-and-instrumentation | Aktiverad | Audit, outbox, repair runs och releaseattest |
| openapi-spec-generation | Villkorlig | API-kontrakt granskat principiellt; ingen OpenAPI-ändring |
| performance-optimization | Aktiverad | Index, locks, batch repair och advisor-gap |
| quality-playbook | Aktiverad | Riskprioritering och verifieringsmatris |
| refactor | Villkorlig | Ingen kodändring i auditfasen |
| sast-configuration | Aktiverad | Guard-/SAST-coverage och bypassrisker |
| secrets-management | Aktiverad | Service role och deployment boundary |
| security-and-hardening | Aktiverad | RLS, grants, definer functions, immutability |
| security-threat-model | Aktiverad | Tenant escape, replay och ekonomisk manipulation |
| skill-scanner | Aktiverad | Skillinventory, lock och källproveniens |
| source-driven-development | Aktiverad | Fynd bundna till repositoryevidens |
| sql-optimization-patterns | Aktiverad | Advisory locks, indexes, query/repair design |
| supabase-postgres-best-practices | Aktiverad | RLS, functions, constraints, migrationer |
| supabase | Aktiverad | Projektanslutning kontrollerad; live Nordklart saknades |
| test-driven-development | Aktiverad | Testgap och krav på regression före fix |
| threat-model-analyst | Aktiverad | Aktör, tenant, tillgång, payment och repair threats |
| vercel-cli-with-tokens | Ej exekverad | Ingen token-/deployoperation behövdes |
| vercel-composition-patterns | Villkorlig | Ingen komponentrefactor i auditfasen |
| vercel-react-best-practices | Aktiverad begränsat | Build-/server boundary; ingen full UI-profilering |
| vercel-react-native-skills | Ej relevant | Repositoryts granskade mål är inte React Native |
| vercel-react-view-transitions | Ej relevant | Ingen view-transition-implementation granskades |
| web-design-guidelines | Ej exekverad | Uppdraget avsåg systemkonsistens, inte visuell UI-audit |

### Skill-integritetsresultat

- Installerade/låsta skills: 41
- Dokumenterade i source-registret: 35
- Saknad proveniens: 6

---

# 10. Slutlig slutsats

Nordklart har flera korrekta arkitekturval, särskilt i den senaste finansiella databashärdningen. Det finns inget i denna statiska granskning som bevisar en pågående kritisk cross-tenant-exploit eller att postade journaler fritt kan ändras.

Den största bristen är att **systemets påstådda garantier inte är kopplade till en obruten och obligatorisk beviskedja från commit till CI, riktig PostgreSQL, live Supabase och produktionsdeploy**.

Prioriteten ska därför vara:

1. skydda releasekedjan,
2. verifiera live-databasen,
3. sluta den sista atomiska gränsen,
4. sanera historiska avvikelser,
5. bygga den fulla testmatrisen,
6. därefter gå vidare med funktionsutbyggnad.

Att bygga fler bokföringsfunktioner innan dessa steg är klara ökar kostnaden för varje framtida fel och gör felsökning svårare. Grunden är tillräckligt bra för att härdas vidare, men inte tillräckligt bevisad för att kallas fullständigt konsekvent idag.
