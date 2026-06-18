# Nordklart – runtime- och workspaceaudit

**Granskad bas:** `nordklart-main.zip` från 18 juni 2026.  
**Metod:** statisk granskning av route-, workspace-, onboarding- och middlewareflöden samt jämförelse mellan 45 produktionsanrop till Supabase RPC och SQL-migrationernas funktionsdefinitioner. Ingen live-databas eller produktionsmiljö har använts i granskningen.

## Sammanfattning

Det rapporterade beteendet hade en gemensam grundorsak: kod för den nya workspace-/onboardingmodellen var deployad medan delar av dess databas- och accesskontrakt kunde saknas eller svara fel. Flera lager antog samtidigt att RPC:erna alltid fanns. Ett fel blev därför en global dashboardkrasch i stället för en kontrollerad fallback.

Den här patchen inkluderar den tidigare recovery-patchen och utökar den så att samma felklass inte finns kvar i middleware, onboardingavslut, inbjudningsflöde eller konto-radering.

## Åtgärdade fel i denna patch

| Prioritet | Fel | Konsekvens | Åtgärd |
|---|---|---|---|
| Kritisk | `resolve_company_access` och `list_accessible_companies` kunde kasta i dashboardens serverlayout. | `/app` föll till den generella felsidan och sidebar/navigation försvann. | Säker fallback till den inloggade användarens **egna** `company_members`-rad. Fallbacken filtrerar explicit på `user_id`; den förlitar sig inte bara på RLS. |
| Kritisk | Edge-middleware gjorde egna hårda RPC-anrop. | Användaren kunde skickas tillbaka till onboarding även när arbetsytan fanns. | Samma direkta, användarfiltrerade reservväg finns nu i middleware. |
| Kritisk | Startvalet i onboarding visade fel trots att arbetsytan redan var skapad. | “Kunde inte spara valet just nu” följt av fungerande `/app`. | Route returnerar ett giltigt nästa steg och persisterar via service-fallback när RPC saknas. |
| Hög | `complete_core_onboarding` hade samma hårda RPC-beroende. | “Slutför installation” kunde ge 500 och låsa kvar användaren. | Idempotent DB-funktion plus serverfallback som inte blockerar ett redan provisionerat bolag. |
| Hög | Recovery-fallbacken från den tidigare patchen kunde läsa flera medlemsrader i delade bolag. | `maybeSingle()` kunde misslyckas när ett bolag hade fler medlemmar. | Fallbacken hämtar nu aktuell auth-användare och filtrerar varje medlemsfråga på `user_id`. |
| Hög | `check_email_exists` anropades i inbjudningsflödet men saknade SQL-definition. | Felaktig “ny användare”-presentation eller tyst fel. | Ny privat service-role-funktion och graciös UI-fallback; inbjudan går fortfarande att använda om presentationstippen fallerar. |
| Hög | Inbjudningsuppslag översatte databaskrasch till “inbjudan saknas/är ogiltig”. | Felsökning blev missvisande för användare och support. | Riktigt databasfel blir nu 503 med tydligt fel, medan ogiltig token fortsatt ger 404/400. |
| Hög | `anonymize_user_account` anropades av konto-radering men saknade SQL-definition. | Konto-radering gav 500 varje gång. | Ny anonymiseringsfunktion: blockerar aktiva bolagsägare, tar bort medlemskap och direkt PII, men behåller bokförings- och revisionsdata samt auth-tombstone. |
| Hög | Konto-radering, onboardingmutationer och signup-retry kunde läsa auth direkt utan central MFA-kontroll. | Skyddsnivån blev inkonsekvent för känsliga mutationer. | Routes använder nu `requireAuth()`. Projektets auth-guard är grön och antalet råa route-anrop minskar med 18. |
| Medium | Assistentens kontosammanfattning anropade saknade `agent_top_accounts_for_company`. | Assistenten tappade topplistor över konton utan att få en effektiv databasaggregering. | Ny RLS-respekterande SQL-funktion med aggregering i databasen. |
| Medium | Onboardingens breda kort låg i en global `max-w-lg`-wrapper. | Fyrkolumnsgrid blev cirka 90 px per kort på desktop. | Breda routervyn använder full layoutbredd; klassiska formulärflöden behåller egen `max-w-lg`-ram. |

## Kvarvarande fel som inte ska aktiveras före en separat datamodellfix

### 1. Äldre moms-/skattekodsmodul saknar både tabell och RPC

`lib/core/tax/tax-code-service.ts` använder `tax_codes` och `seed_tax_codes_for_user`, men migrationshistoriken innehåller varken tabellen eller funktionen. Modulen blandar dessutom `userId` och `company_id`, vilket är fel i den nuvarande multi-tenantmodellen.

**Nuvarande risk:** Funktionen är inte en del av det aktiva huvudflödet, men den kommer att krascha om ett nytt momsflöde importerar eller anropar den.

**Rätt fix, i en egen batch:**
1. Definiera en company-scoped `tax_codes`-tabell med systemkoder och tenant-överlagringar.
2. Byt service-API från `userId` till `companyId`.
3. Definiera BAS-/Skatteverket-mappning, rätt momsboxar och seed-policy innan någon seed körs.
4. Lägg till data-/migrations- och beräkningstester med riktiga momsfall.

Den här patchen gömmer inte felet med en tom no-op-funktion, eftersom det skulle skapa en falsk känsla av fungerande momshantering.

### 2. Äldre råa auth-anrop i befintliga routes

Projektets guard rapporterar fortfarande 153 äldre direkta `supabase.auth.getUser()`-anrop. De är inte automatiskt säkerhetsfel: några är avsiktliga undantag, bland annat första lösenordssättning för BankID-användare där en MFA-kontroll kan skapa lockout.

**Rätt nästa steg:** klassificera dem route för route och flytta alla vanliga läs-/skrivflöden till `withRouteContext()` eller `requireAuth()`. Prioritera först konton, företagsmedlemmar, inställningar, API-nycklar och behörighetsändringar. Låt bara dokumenterade onboarding-/återställningsundantag vara kvar.

### 3. Deployordning är fortfarande ett driftkrav

Serverfallback skyddar användaren vid en kort rolloutmiss, men ersätter inte databasmigrering. Om `SUPABASE_SERVICE_ROLE_KEY` saknas kan fallback endast logga/passa vidare, inte persistera optional onboardingdata.

**Rätt driftordning:** migrera SQL först, deploya sedan kod och verifiera funktionerna med SQL-kontrollen nedan.

## SQL-kontroll efter migrering

```sql
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'select_onboarding_start_path',
    'complete_core_onboarding',
    'check_email_exists',
    'agent_top_accounts_for_company',
    'anonymize_user_account'
  )
order by routine_name;
```

Resultatet ska innehålla fem rader.

## Verifierade kontroller i kodbasen

- 45 produktionsanrop till Supabase RPC identifierades.
- Efter patchen har 44 av 45 en SQL-definition i migrationshistoriken.
- Den enda kvarvarande saknade RPC:n är den medvetet ej-aktiverade `seed_tax_codes_for_user`, beskriven ovan.
- Projektets `check:guards` är grön efter ändringen.

## Ej verifierat i denna miljö

Den uppladdade zippen saknar installerade Node-beroenden (`node_modules/.bin` saknas). Därför kunde full ESLint-, TypeScript- och Next.js-build inte köras lokalt här. Kör detta efter att patchen lagts in:

```bash
npm ci
npm run check:guards
npm run lint
npm run build
```
