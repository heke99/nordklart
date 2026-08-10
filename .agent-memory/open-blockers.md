# Aktiva blockerare och skuld

Uppdaterad 2026-08-10, efter att produktionsdeployen slutfördes från
`claude/nordklart-remediation-hardening-lbyqtt`.

Allt nedan är verifierat mot den riktiga databasen i samma arbetspass.

## Produktionsstatus

Projekt `rpajvvngvcutffwucbdy`, PostgreSQL 17.6. **Repot och produktion är i
samma tillstånd.** Liggaren står på **376** rader, 444 filer i repot.

| Fynd | Live-status |
|---|---|
| #17 cross-tenant-vyer | **STÄNGD** — `security_invoker=true` på de fyra som läckte |
| #18 `commit_journal_entry` | **STÄNGD** — anon saknar EXECUTE, anon-guard och write-authz i kroppen |
| #19 write-policies (`user_company_ids`) | **STÄNGD** — 154 → 0 |
| child-row-policies | **STÄNGD** |
| #22 write-policies (`user_can_access_company_v2`) | **STÄNGD** — 29 → 0 |
| settlement v2 | **LIVE** — 3/3 funktioner, anon nekad, service_role tillåten |
| #16 `commit_method='system'` | **LIVE** |
| invoice financing (#387) | **LIVE** — 5 tabeller, var helt oapplicerad |
| SECURITY DEFINER utan pinnad search_path | **0** |
| Tabeller utan RLS i `public` | **0** |

Deployen gjordes med `scripts/deploy-migration-via-mcp.mjs`: filen delas i
checksummade bitar, databasen räknar om sha256 på det den faktiskt tog emot,
och ingenting körs förrän det hopsatta innehållet hashar till samma sha256 som
filen på disk. En felskrivning kan alltså inte nå schemat — bara avbryta
deployen. Verifierat i alla fyra lägen mot en lokal replay först: exakt
överföring, upptäckt manipulation, atomisk applicering, vägran att köra om.

`20260808160000_authorize_commit_journal_entry.sql` är **registrerad som
superseded utan att ha körts**. Den efterträds helt av `20260808190000`, som
redan är live. Hade den fått köras efteråt hade den skrivit över funktionen
*utan* anon-guarden och öppnat #18 igen. Raden finns just för att `db:migrate`
aldrig ska plocka upp den.

## Fynd i detta arbetspass

**#22 — den andra medlemskapsvägen.** `user_can_access_company_v2()` betyder
samma sak som `company_id IN (SELECT user_company_ids())` men heter något annat.
Båda tidigare svepen sökte bara efter det ena namnet, så 29 write-policies över
15 tabeller släppte igenom en viewer — bland dem `payment_initiations` (initierar
riktiga utbetalningar), invoice financing, periodiseringsscheman och
`arsredovisning_submissions`. Vakten i `tenant-isolation-matrix` matchar nu båda
hjälpfunktionerna; den kände bara till den ena, vilket är exakt därför de 29
passerade den. Ett predikat är på läsnivå på grund av vad det betyder, inte hur
det stavas.

Två policies lämnades medvetet: `signed_consents_insert` och
`bolagsverket_avtal_acceptances_insert` pinnar redan `user_id = auth.uid()` och
registrerar att en identifierad person signerat med BankID. Att kräva skrivrätt
på personliga rader är precis det som låste ute revisorer från assistenten i
`20260808180000`. **Öppen produktfråga:** om signering också ska kräva
skrivrätt hör det hemma i routen som begär signaturen, inte i ett mekaniskt
svep.

## Kvarvarande

1. **Historisk ledger-reconciliation är inte gjord.** 444 filer i repot, 376
   rader i liggaren. De 68 utan rad är verifierat applicerade sedan tidigare
   (fingerprint-matchade, CHECKSUM_MISMATCH = 0), men raderna är inte skrivna.
   Skriv dem fil för fil — **aldrig `mark-through`, aldrig intervall**. Se
   varningen i `next-actions.md`.

2. **`skatteverket_connections_v` saknar `security_invoker`.** Granskad, inte
   en läcka: vyn bär sitt eget tenantfilter i kroppen
   (`company_id IN (SELECT user_company_ids())`), så anon ser noll rader —
   uppmätt. Den vilar dock på vyns predikat i stället för på tabellens RLS.
   Att sätta `security_invoker` vore striktare, men tabellen är tom i
   produktion så beteendet går inte att validera efteråt. Härdning, inte
   incident.

3. **Leaked-password protection är avstängt.** Dashboard-only. EXTERN ÅTGÄRD.

4. **Branch protection går inte att konfigurera.** Privat repo på GitHub Free;
   `/rulesets` och `/branches/main/protection` svarar 403 *"Upgrade to GitHub
   Pro or make this repository public"*. Plangräns, inte behörighetsgräns.

5. **GitHub Actions tilldelar inga runners.** Minuterna är slut (bekräftat av
   användaren). Alla grindar körs lokalt tills det ändras.

## Testläge

Uppmätt på branchens HEAD, efter `npm run test:pg:reset`:

| Svit | Resultat |
|---|---|
| unit | 6182 passerade, 3 skippade (500 filer) |
| pg-real | 675 passerade (92 filer), 59 s |
| typecheck | rent |
| lint | 0 errors, ratchet-baseline 0 |
| guards | 6/6 |
| migrationsreplay | 444/444 från tom databas |

Inget test är borttaget, skippat eller nedgraderat.

## Kvarvarande produktarbete (oförändrat)

- Samlad produktionsroute som både länkar och vid behov bokar betalning av
  migrerade AR/AP-poster atomiskt.
- Import av äldre kontoutdrag till radnivå (parser/UI).
- Fullständigt fält-för-fält merge-UI mot Bolagsverket-snapshot.

## Miljö

- Bygget hämtar Google Fonts över nätet; hermetisk CI kan falla på det.
- pg-real kör Postgres som vanlig docker-container, inte som `services:`.
  `postgres` är inte superuser i supabase-imagen, så ALTER SYSTEM nekas.
