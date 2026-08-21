# Nordklart — produktionsfärdigställande, 2026-08-21

Branch: `claude/nordklart-production-ready-w4szxu`. Sju commits, tio
migrationer, samtliga deployade till produktionsprojektet
`rpajvvngvcutffwucbdy` i versionsordning via det checksummade
deploy-skriptet.

Rapporten följer sektionsindelningen A–M.

---

## A. Implementation

Utgångsläget var moget: typecheck rent, lint 0 fel, sex guards, 6 184
unit-tester, 675 pg-real-tester, 450 migrationer som replayade rent från tom
databas. Det som saknades var inte grundarkitektur utan **konvergens, paritet
och ett antal konkreta buggar**. Arbetet delades i sju block.

**Block 1 — säkerhet och atomicitet.**

1. *MFA-bypass.* `lib/auth/mfa.ts` undantog varje konto med
   `app_metadata.bankid_linked` från TOTP. `POST /bankid/link` sätter den
   flaggan på ett **befintligt lösenordskonto**, så kontot kunde därefter logga
   in med lösenord helt utan andra faktor. Undantaget kräver nu att kontot
   saknar eget lösenord.
2. *Storno och rättelse.* `reverseEntry` gjorde 5+ separata skrivningar,
   allokerade verifikationsnumret i förväg (varje senare fel brände ett nummer
   ur serien) och postade med en rå `UPDATE status='posted'` — förbi
   `commit_journal_entry` och därmed förbi dess anon-guard och skrivkontroll.
   `correctEntry` gjorde ~8 skrivningar över två verifikat med handrullad
   kompensation. Nu bygger TypeScript planen och en RPC skapar, länkar,
   committar och vänder originalet i **en** transaktion.
3. *Falsk betalvägg.* Vy-fallbacken i `listCompanyFeatureAccess` tappade
   `reason`, och dashboard-layouten litade på `enabled === false`. Ett
   databasfel såg alltså ut som "du har inte betalat". Fallback-rader märks nu
   `degraded` och om-verifieras.
4. *Personnummer.* `customers.personal_number` visade sig aldrig ha skrivits —
   formuläret samlade in det, schemat validerade det, och både POST och PATCH
   byggde sin payload fält för fält utan att ta med det. Fältet är nu inkopplat
   och krypterat från början.
5. *Signaturbevis.* `markSignatureSigned` lämnade `signer_personnummer_hash` och
   `_encrypted` tomma och felet sväljdes, så ett samtycke kunde registreras,
   sessionen bli `complete`, användaren se en lyckad signering — och
   signaturbegäran stå kvar som `pending`. Nu en transaktion.

**Bonusfynd, latent produktionsbugg.** `audit_annual_report_document_change`
delas av tre tabeller men läste `NEW.created_by`, som bara en har.
TG_TABLE_NAME-guarden skyddar inte: PL/pgSQL cachar den preparerade planen på
funktionen, inte per radtyp. Årsredovisningssignering gick sönder beroende på
vad den poolade anslutningen råkat röra först, och passerade varje test som
bara använde en tabell per connection. Reproducerat mot den gamla definitionen
före fixen.

**Block 2 — trasiga användarflöden.** Middleware läste BankID-enrichment från
en död plats, så varje BankID-användare med enrichment skickades till
`/onboarding` i stället för `/select-company`. Två 404-länkar bakom synliga
knappar. Skatteverkets readiness-panel kunde visa `production_ready` medan
token-anropet skulle kasta.

**Block 3 — skuldkampanjer.** 84 routes flyttade till `withRouteContext`;
`raw-route-auth` 167 → 83.

**Block 4 — BankID.** Se sektion C.

**Block 5 — Skatteverket.** Se sektion D.

**Block 6 — röjning.** Tio döda rotartefakter borttagna, sex rapporter
statusmärkta och arkiverade, `.env.example` skapad med guard.

**Block 7 — andra granskningen.** Se sektion G; den gav pass ett kritiskt fynd.

---

## B. Databas

Tio nya migrationer, alla med `*.pg.test.ts`:

| Version | Innehåll |
|---|---|
| 20260821120000 | `reverse_journal_entry_v2` — atomisk storno och rättelse |
| 20260821130000 | `customers.personal_number_enc` + `_last4`, klartextkolumn droppad efter nollkontroll |
| 20260821140000 | `record_bankid_consent_v1` — samtycke, audit och signaturbegäran i en transaktion |
| 20260821150000 | Delad trigger läser `to_jsonb(NEW)->>'field'` i stället för `NEW.created_by` |
| 20260821160000 | `rate_limit_counters` + `consume_rate_limit` |
| 20260821170000 | `bankid_sessions.user_id` nullbar för `purpose='auth'`, unik providerreferens, städfunktion |
| 20260821180000 | `user_identity_verifications` droppad (tom, oanvänd, dubblerad) |
| 20260821190000 | `skatteverket_ombud_authorizations` + `record_skv_ombud_observation` |
| 20260821200000 | `idempotency_key`, `attempt_count`, `next_retry_at` på `skatteverket_api_requests` |
| 20260821210000 | Anon förlorar EXECUTE på 144 SECURITY DEFINER-funktioner |

Regler som hållits: nullable → backfill → verify → constraint; inga ekonomiska
rader raderas som rollback; varje SECURITY DEFINER-funktion pinnar
`search_path`; varje ny funktion är service-role-only om den inte har ett skäl
att vara något annat.

---

## C. BankID

Beslutet var att behålla TIC som enda provider och konvergera. Det som gjordes:

- Login gick **inte** genom `getBankIdProvider()`. Följden: kill-switchen
  `NEXT_PUBLIC_BANKID_ENABLED` stoppade samtyckessignering men inte inloggning,
  och en hostad deploy med trasig providerregistrering hade inget skydd mot att
  falla igenom till mock. Start, poll, complete, link och cancel går nu genom
  providern.
- `BankIdProvider.result()` tillagd — en idempotent läsning av ett avslutat
  ärende. Completion-steget måste härleda utfallet från providern i stället för
  att lita på webbläsarens påstående, och `collect()` konsumerar progress.
- Login-ärenden skrivs nu till `bankid_sessions` som allt annat.
- Rate limit: `bankIdStartCooldowns` var en in-memory `Map` per instans, tom
  efter varje cold start, framför en oautentiserad rutt där varje anrop öppnar
  en debiterad TIC-session. Nu Upstash när det finns, annars fixed-window i
  Postgres, **fail-closed**.
- QR-koden räknade `setInterval`-tick sedan mount; BankID:s `time` är sekunder
  sedan ordern skapades på servern. I en bakgrundsflik stryps intervallet och
  varje skanning misslyckades. Nu klockbaserat mot ett serveransatt ankare.
- BankID-signup borttaget: ingen sida renderade det, och kontot det skapade
  saknade avtal, plan och bolag.
- Ordval: "signering" → BankID-verifierat samtycke, där TIC:s API bara är
  autentisering.

---

## D. Skatteverket

- **Ombudsmodell.** `skatteverket_ombud_authorizations` håller vad Skatteverket
  faktiskt svarat, per bolag och auth-flöde. `status='active'` är oåtkomligt
  utom genom ett observerat providersvar — inga skrivgrants till
  anon/authenticated, RLS bara SELECT, skrivning via service-role-RPC som
  *härleder* status, CHECK-villkor som binder status till bevis, och en trigger
  som vägrar varje skrivning RPC:n inte gjort. Ett användarpåstående lagras som
  `claimed` och kan aldrig skriva över ett `skv_response`.
- **Verdikt bara ur riktiga svar.** Lyckat anrop → `active`. 403 med
  behörighetstext → `denied`. En 500, en 401, en utgången session eller ett
  saknat scope säger ingenting om behörighet och skriver ingenting.
- **Retry.** Fanns inte alls. Nu bounded, med två regler: aldrig POST
  (Skatteverket har ingen idempotensheader — en timad POST kan redan ha lämnat
  in), och bara timeout/429/502/503/504, med exponentiell backoff och full
  jitter, och providerns `Retry-After` först.
- **Spårbarhet.** `idempotency_key` grupperar försöken, `attempt_count`
  numrerar dem, `next_retry_at` säger när nästa är i tur — begränsat till rader
  som faktiskt misslyckats.
- **Gate.** `getSkvSysorgAccessToken()` gate:ar på samma predikat som
  readiness-panelen redovisar.
- **Ingen inlämning utan kvittens.** AGI-vägen krävde redan
  `kvittens.uuidKvittens`. De två moms-övergångarna krävde bara `if (data)` —
  ett 200 med tom kropp hade flyttat en inlämning till `signed_submitted`.

---

## E. Bokföring

Inga ändringar av bokföringslogiken i sak. Det som ändrades är hur den
*skrivs*: storno och rättelse är atomiska, verifikationsnummer allokeras bara
inuti `commit_journal_entry`, och `check:financial-hardening` förbjuder nu både
postning utanför den RPC:n och förhandsallokerat nummer i motorerna. Fem
pg-real-tester bevisar att ett avvisat storno lämnar noll verifikat *och*
bränner noll nummer.

---

## F. Prestanda

Inga nya N+1-mönster. Den enda tillagda per-anrops-kostnaden är
ombudsobservationen: en indexerad uppslagning av bolagets org.nummer plus en
RPC per settlat Skatteverket-anrop, bakom ett nätverksanrop som redan tagit
längre tid än båda. `consume_rate_limit` är en enda `INSERT … ON CONFLICT` som
serialiserar på primärnyckeln i stället för att race:a mellan SELECT och
UPDATE, med opportunistisk städning ungefär var tusende anrop.

---

## G. Säkerhet

Fyra fynd av vikt, i stigande allvarlighetsgrad:

1. MFA-bypassen (A.1).
2. Storno förbi `commit_journal_entry`s auktorisering (A.2).
3. BankID-startrutten utan verkningsam rate limit (C).
4. **Anon kunde köra 144 SECURITY DEFINER-funktioner.** Detta är det allvarliga
   fyndet, och det kom ur den andra granskningen. Supabase grantar `anon`
   EXECUTE på allt i `public` som standard. För en vanlig funktion är det
   harmlöst — den kör som anroparen och RLS avgör. För en SECURITY
   DEFINER-funktion är granten hela auktoriseringen. 39 av dem hade ingen egen
   kontroll, och det gick att reproducera:

   ```sql
   SET ROLE anon;
   SELECT public.company_entity_type('<valfritt bolags-id>');   -- 'aktiebolag'
   SELECT public.check_email_exists('someone@example.com');     -- true/false
   ```

   Det är en tvärtenant-läsning och ett användarenumereringsorakel, nåbart med
   enbart den publika nyckeln. Listan innehöll också skrivande funktioner.
   Åtgärdat i 20260821210000. Detaljer i
   `docs/audits/2026-08-21-anon-security-definer-exposure.md`.

   **Hur det hittades är poängen.** Testharnessen grantade `anon` mindre än
   produktion gör. Det är den farliga riktningen: en saknad kontroll var
   onåbar lokalt och öppen i produktion, och sviten blev grön i båda fallen.
   Att göra replayen trogen i stället för smickrande avslöjade det direkt.

---

## H. Tester

| Svit | Före | Efter |
|---|---:|---:|
| Unit | 6 184 | 6 238 |
| pg-real | 675 | 728 |
| Migrationer i ren replay | 450 | 460 |
| Guards | 6 | 8 |

Nya guards: `internal-links` (failar på intern länk utan route bakom sig, och
reproducerar båda 404:orna mot den gamla koden) och `env-example` (failar när
kod läser en variabel `.env.example` inte nämner, inklusive de indirekta
läsningarna som en `process.env.NAME`-scan missar).

Nya pg-real-filer: storno-atomicitet, kundpersonnummer,
BankID-samtyckesatomicitet, den delade triggern, rate-limit-räknarna,
login-sessioner, ombudsmodellen, retry-kolumnerna och anon-ytan.

---

## I. Ändrade filer

217 filer: 49 nya, 10 borttagna, 153 ändrade, 5 flyttade. Tyngdpunkterna är
`app/api/**` (84 routekonverteringar), `lib/auth/**`, `lib/skatteverket/**`,
`extensions/general/{tic,skatteverket}/**`, `supabase/migrations/**` och
`tests/pg/**`.

---

## J. Migrationer

Se sektion B. Alla tio deployade till produktion i versionsordning. Metod:
filen delas i chunkar med sha256 per chunk, databasen räknar om hashen på det
den faktiskt tagit emot, och ingenting kör förrän den återsammansatta texten
hashar till samma värde som filen på disk. Migrationen och dess ledgerrad kör
som en DO-block-transaktion. Produktionsledgern står på 460, lika med repot,
och stagingtabellen är tom.

---

## K. Deployment

Inga ändringar i deployment-topologin. `docker-entrypoint.sh` hänvisade till en
`.env.docker.example` som aldrig legat i repot; den pekar nu på `.env.example`,
som numera finns. Städningen av oanspråkade BankID-login-ärenden kör från den
befintliga dygnscronen (`/api/events/cleanup/cron`) i stället för att lägga
till en sjuttonde post i `vercel.json` — så Vercel-schemat och Docker-crontab
förblir i takt.

---

## L. Miljövariabler

`.env.example` skapad: 147 variabler som koden faktiskt läser, grupperade och
kommenterade, med `[required]`/`[hosted]`/`[extension]`/`[optional]`.
Fullständigheten upprätthålls av `scripts/checks/env-example.mjs`.

Nya variabler i den här leveransen: inga. Två fick skärpt semantik —
`BANKID_HASH_SECRET` accepterar inte längre `SUPABASE_SERVICE_ROLE_KEY` som
fallback (rotation av den nyckeln hade tyst föräldralöst varje identitet), och
`SKV_*`-uppsättningen gate:ar nu token-anropet i stället för att avslöjas en
variabel i taget.

---

## M. Externa blockerare

| Id | Krav | Kodstatus |
|---|---|---|
| BANKID-01 | Riktig signering kräver BankID RP-avtal; TIC exponerar bara auth-API | Beslutat bort — produkten kallar det BankID-verifierat samtycke, och UI-texten säger det |
| SKV-01 | Organisationscertifikat (Expisoft) + Skatteverkets godkännande för `sysorg` | Implementerat och gate:at på readiness; ingen kod saknas |
| SKV-02 | Deklarationsombud ges av kunden på Mina sidor; inget API för att bevilja, och inget för att fråga | Modellen byggd; status sätts bara av observerat providersvar |
| SUPA-01 | Leaked-password protection är Dashboard-only | Kan inte sättas från migration |
| GH-01 | Branch protection kräver GitHub Pro på privat repo | — |
| GH-02 | Actions-minuter slut | Grindarna körda lokalt; CI kör samma kommandon |

Inget av dessa hindrar kod från att vara färdig. Var och en är ett avtal, ett
certifikat eller en dashboard-inställning.
