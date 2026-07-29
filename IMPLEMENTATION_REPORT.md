# Implementeringsrapport — kanonisk SIE-import och historiska stödregister

Datum: 2026-07-29

## Resultat

Ändringen etablerar en gemensam identitets- och statusmodell för SIE, hållbara
parse-sessioner med arkiverat original, separata historiska stödregister och ett
gemensamt kontrollkontrakt för bokslut. Huvudboken förblir den enda
redovisningsmässiga sanningen; komplettering av stödregister skapar inte
verifikationer.

Leveransen är kod- och byggverifierad. Den är inte produktionsgodkänd förrän de
tre nya migrationerna och pg-real/RLS/concurrency-testerna har körts mot en
riktig PostgreSQL-testdatabas. Se `KNOWN_LIMITATIONS.md`.

## Verifierade grundorsaker

- SIE-status fanns duplicerad i TypeScript och motsvarade inte alla
  databaslägen; särskilt `staged` saknades i delar av bokslutsflödet.
- Parse och execute använde inte samma storleksgräns och execute kunde arbeta
  från en ny klientuppladdning i stället för det arkiverade parse-originalet.
- Juridisk identitet kontrollerades inte konsekvent vid parse, execute,
  databasfinalisering och ersättning.
- Kundreskontra och bokslut använde olika uppsättningar kontrollkonton.
- Det saknades en separat modell för redan bokförda historiska AR/AP-poster.
- Bokslutskontrollerna saknade ett strukturerat kontrakt för belopp, differens,
  underlag, stale-status och möjliga åtgärder.
- Årsredovisningens eget-kapitalflöde kunde härleda utdelning från ett generiskt
  `result_appropriation` i stället för ett uttryckligt beslut.

## Implementerad lösning

### SIE

- En kanonisk statusdefinition:
  `pending`, `validating`, `staged`, `importing`, `partial`, `mapped`,
  `completed`, `failed`, `replaced`, `undone`.
- Gemensam normalisering och jämförelse av organisationsnummer med resultaten
  `match`, `missing_in_sie`, `missing_in_company` och `mismatch`.
- Samma identitetskontroll körs vid parse och execute. Databasmigrationen lägger
  ett fail-closed-omslag runt `finalize_sie_import`.
- Parse skapar en hållbar session och arkiverar originalfilen före ekonomisk
  commit. Execute laddar ned, hashverifierar, parserar om och identitetskontrollerar
  det arkiverade originalet.
- Gemensam gräns på 50 MiB används i parse och execute.
- Append-only `sie_import_corrections` bevarar originalvärden och godkännanden.
- Dashboard- och v1-routen använder samma session- och identitetsmodell.

### Historiska stödregister

- Gemensam, explicit `year_end_control_accounts` används av avstämningar och
  AR-rapport i stället för hårdkodad 1510-logik.
- Separata migrerade kund- och leverantörsposter, dokument,
  verifikationskopplingar och betalningsreferenser.
- Varje migrerad post låses till
  `accounting_origin = imported_sie` och
  `recognition_status = already_booked`.
- Itemiserat och externt verifierat läge är ömsesidigt uteslutande per
  period/kontrollkonto.
- Serverfunktionerna `customer_receivables_reconciliation_at` och
  `supplier_payables_reconciliation_at` räknar huvudbok, intern reskontra,
  historiskt stöd, differens, underlag och stale/import-invalidation.
- Historiska bank-, eget-kapital-, skatt- och momsavstämningar samt dokument och
  append-only-invalidationer har införts.
- UI och API stödjer företag/periodbundna kompletteringar och verifieringar utan
  att skapa bokföring.

### Bokslut och årsredovisning

- `year_end_control_status` returnerar
  `reconciled`, `completion_required`, `manual_verification_required` eller
  `accounting_error` med belopp, differens, stale-status, blockeringsstatus och
  åtgärder.
- `year_end_db_blockers` blockerar även `staged` samt övriga icke-slutliga eller
  felaktiga SIE-lägen.
- Den atomiska stängningsfunktionen återkontrollerar blockerare under lås och
  hanterar föregående års resultatöverföring exakt en gång, alternativt länkar
  en motsvarande SIE-överföring.
- Företagssnapshot kan låsas för perioden och årsredovisningen läser den låsta
  snapshoten, inte en senare ändrad profil.
- Strukturerad resultatdisposition, utdelningsförslag, utdelningsbeslut,
  dokument och eget-kapitalhändelser ersätter utdelningsgissning.
- Årsredovisningen använder huvudbokssaldo och lägger inte historiska
  stödobjekt ovanpå huvudboken.
- Bokslutsanteckningar har uttrycklig synlighet; endast
  `annual_report` hämtas till årsredovisningen.

## Databas- och säkerhetsregler

- Endast nya framåtriktade migrationer har lagts till; inga befintliga
  migrationsfiler ändrades.
- CI-guarden tillåter endast de två exakta äldre dubblettuppsättningarna och
  stoppar nya dubblettversioner eller en ny fil i en äldre uppsättning.
- Tabeller är företag- och periodbundna med RLS för läsning.
- Skrivning sker genom serverroutes eller säkra RPC:er; append-only-tabeller har
  spärrar mot direkt ändring.
- `SECURITY DEFINER`-funktioner använder fast `search_path`, kontrollerar
  företag/aktör och återkallar breda standardrättigheter.
- Snapshot-hashar och invalidationer gör att ändrad huvudbok, import eller
  stöddata öppnar kontrollen igen.
- Slutförande och resultatöverföring sker under databaslås och
  idempotensskydd.

## Migrationer

1. `20260729160000_sie_identity_parse_sessions_and_corrections.sql`
2. `20260729161000_historical_ar_ap_support_ledgers.sql`
3. `20260729162000_historical_year_end_controls_and_atomic_close.sql`

Migrationerna ska appliceras i denna ordning före applikationskoden. Full
driftsättnings- och återställningsinformation finns i `MIGRATION_ORDER.md`.

## Verifiering

- TypeScript: PASS.
- Ändringslint: PASS, 0 fel och 10 varningar.
- Lint-baslinje: PASS, 0 nya fel.
- Guards: PASS.
- Riktade regressionstester: PASS, 41 tester.
- Full unit-svit: PASS, 6 109 tester; 2 skip.
- Next-produktionsbygge: PASS, 355 sidor.
- Befintliga migrationschecksummor: PASS, 416 SQL-filer oförändrade.
- pg-real/RLS/concurrency och live migrationsstatus: INTE KÖRDA; ingen
  PostgreSQL-anslutning finns i leveransmiljön.

Detaljer och exakta kommandon finns i `TEST_RESULTS.md`.

## Rollback

Ta alltid en databasbackup före migration. Migrationerna är additiva, men de
lägger även omslag runt befintliga finaliserings- och stängningsfunktioner.
Rollback ska därför ske genom en ny framåtriktad kompensationsmigration som
återställer funktionsnamn och tar bort nya objekt först när all ny data har
exporterats eller bedömts obehövlig. Redigera eller byt inte namn på redan
applicerade migrationsfiler.

Applikationsrollback bör ske efter att ett kompatibelt databasomslag finns;
gammal kod mot delvis återställd databas är inte en säker rollback.

## Externa beroenden

- Supabase/PostgreSQL för migrationer, RLS- och concurrency-verifiering.
- Supabase Storage-bucket `sie-files` för arkiverade original.
- Befintliga Bolagsverket-/registersnapshot-flöden används där data finns.

## Kvarvarande begränsningar

Se `KNOWN_LIMITATIONS.md`. De viktigaste är att produktionsroute för atomisk
betalning av migrerade AR/AP-poster och radimport av historiska kontoutdrag
ännu inte är fullständiga, samt att företagssnapshot-UI:t ännu inte erbjuder
fältvis merge mellan samtliga fyra källor.
