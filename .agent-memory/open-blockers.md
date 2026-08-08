# Aktiva blockerare och skuld

Uppdaterad 2026-08-08, efter remediation-branchen
`claude/nordklart-remediation-hardening-lbyqtt` (PR #7).

Allt nedan är verifierat i arbetspasset. Punkter som tidigare stod som
blockerare men nu är motbevisade eller åtgärdade ligger längst ned.

## Blockerande före produktionsanspråk

1. **De sex säkerhetsfynden är fixade i repot men inte i produktion.**
   Produktion ligger 12+ migrationer efter branchen, så #16–#21 är levande i
   drift tills branchen är deployad. Ordning och verifieringsfrågor står i
   `next-actions.md` — `db:migrate` får inte köras före `mark-through`.

2. **Leaked-password protection är avstängt.** Dashboard-only. EXTERN ÅTGÄRD.

3. **Branch protection går inte att konfigurera.** Privat repo på GitHub Free;
   `/rulesets` och `/branches/main/protection` svarar 403 *"Upgrade to GitHub
   Pro or make this repository public"*. Plangräns, inte behörighetsgräns. CI
   kan alltså inte krävas för merge — den är rådgivande tills planen ändras.

## Fynd från detta arbetspass (alla fixade i repot)

| # | Fynd | Fix |
|---|---|---|
| 15 | `supplier_invoice.paid`-eventet tappades av `127bcf1` | återinfört i `mark-paid-service.ts` |
| 16 | `commit_method='system'` förbjuden av sin egen CHECK — slår till vid *andra* bokslutet i rad för AB | `20260808140000` |
| 17 | Fyra vyer läckte tvärs över tenants (388 / 4 433 / 22 165 / 104 främmande rader, uppmätt) | `20260808150000` |
| 18 | `commit_journal_entry` saknade auktorisation helt | `20260808160000` |
| 19 | 147 write-policies auktoriserade på läsnivå-medlemskap över 57 tabeller | `20260808170000` |
| 20 | `resolveSieImportAccess` härledde skrivrätt ur `effective_role` och promoverade `active_limited` | `lib/import/access.ts` |
| 21 | Återkallad plattformsroll auktoriserade fortfarande (`revoked_at` filtrerades inte) | två routes + permanent guard |

Två av dem är värda att minnas för formen, inte bara innehållet:

- **#18 var inte helt fixad förrän CI körde.** `REVOKE ... FROM PUBLIC`
  verifierades mot en vanlig PostgreSQL, där PUBLIC är enda vägen in. Supabase
  kör `alter default privileges ... grant all on functions to ... anon`, så
  varje funktion i `public` får ett **eget** anon-grant som ett PUBLIC-revoke
  inte rör. anon behöll EXECUTE — och eftersom `auth.uid()` är NULL för anon
  hoppades hela skrivkontrollen över. `20260808190000` tar bort grantet och
  låter kroppen avvisa anon explicit. Ingen lokal databas kunde ha hittat det;
  repots första CI-körning gjorde det.

- **#19 var för brett i tre tabeller.** `agent_conversations`, `chat_sessions`
  och `chat_messages` är en användares egen konversation, inte bolagsdata. Krav
  på bolagsskrivrätt låste ute viewers och auditors från assistenten.
  `20260808180000` byter till medlemskap **och** `user_id = auth.uid()` — smalare
  än båda tidigare versionerna, som lät vem som helst med skrivrätt redigera
  någon annans konversation.

## Testläge

| Svit | Antal | Not |
|---|---:|---|
| unit | 6175 | `origin/main` har 53 failures i 10 filer |
| pg-real | 669 | var 509 vid passets början |

Inget test är borttaget, skippat eller nedgraderat. Varje failure klassades
(TEST_STALE / PRODUCT_BUG / MOCK_STALE / CONTRACT_DRIFT) och åtgärdades i den
ände klassningen pekade på.

## Kvarvarande produktarbete (oförändrat)

4. Samlad produktionsroute som både länkar och vid behov bokar betalning av
   migrerade AR/AP-poster atomiskt.
5. Import av äldre kontoutdrag till radnivå (parser/UI).
6. Fullständigt fält-för-fält merge-UI mot Bolagsverket-snapshot.

## Miljö

7. Bygget hämtar Google Fonts över nätet; hermetisk CI kan falla på det.
8. pg-real kör Postgres som en vanlig docker-container, inte som `services:`.
   Runnern dumpar hela service-containerns logg vid teardown, och sviten
   provocerar fel med flit — dumpen blev ~500 kB och tryckte ut vitest-utskriften
   ur det Actions-API:t lämnar tillbaka. Att tysta servern går inte: `postgres`
   är inte superuser i supabase-imagen, så ALTER SYSTEM nekas.

## Stängda antaganden

- ~~"Unit-sviten failar."~~ 6175/6175.
- ~~"H-03 betalningsatomicitet."~~ Settlementet skapar sitt eget verifikat inne
  i transaktionen; den kompenserande draft-annulleringen är borttagen.
- ~~"H-05 testmatrisen."~~ Concurrency, failure injection, Stripe-livscykel,
  bokslut, SIE, engångsköp och tenant-isolering finns i pg-real.
- ~~"Migrationsliggaren beskriver inte databasen."~~ Verktyget finns och är
  verifierat i båda riktningarna; körningen mot produktion är en operatörsåtgärd.
- ~~"`SUPABASE_DB_URL` saknas, ingen DB kan nås."~~ Live-projektet är nåbart och
  pg-real kördes mot riktig PostgreSQL.
- ~~"Två dubbla migrationsversioner är ett olöst problem."~~ Egen runner nycklar
  på fullt filnamn; CI-guarden bär dem som stängd allowlist.
- ~~"6 skills saknar proveniens."~~ Det var den härledda TSV-filen som var gammal.
