# Nästa exakta åtgärder

Uppdaterad 2026-08-08, efter remediation-branchen
`claude/nordklart-remediation-hardening-lbyqtt` (PR #7).

Allt som tidigare stod här — pg-real grönt, H-03-atomiciteten,
testmatriserna, redefinitionsgranskningen — är gjort. Det som återstår är
deploy och två saker som kräver en människa.

## 1. Deploya till produktion — LÄS DETTA FÖRST

**Den tidigare dokumenterade sekvensen här var farlig och är borttagen.**
Den sa `db:migrate:mark-through -- 20260801140000_...`. Verifierat mot live
2026-08-09: den hade skrivit ledger-rader för filer som ALDRIG applicerats, och
`db:migrate` hade sedan hoppat över dem för alltid.

Två oberoende fällor, båda konstaterade i produktion:

1. **`mark-through` markerar ett intervall, inte verifierade filer.**
   `20260712120000_invoice_financing.sql` (#387) ligger inuti intervallet men
   är helt oapplicerad — 5 tabeller, 8 index, 11 policies och 1 funktion saknas.

2. **Objektexistens kan inte avgöra om en *ersättande* migration är körd.**
   `20260808150000`–`20260808190000` och `20260809100000` gör `DROP/CREATE
   POLICY` med oförändrade namn och `CREATE OR REPLACE FUNCTION` på befintliga
   funktioner. Objekten finns redan, så både `mark-through` och reconcilerns
   `--apply` klassar dem som applicerade. Live-innehållet visar motsatsen:

   | Kontroll | Live 2026-08-09 |
   |---|---|
   | vyer med `security_invoker=true` | **0 av 4** |
   | `anon` kan köra `commit_journal_entry` | **ja** |
   | `commit_journal_entry` innehåller `user_can_write_company` | **nej** |
   | write-policies på enbart medlemskap | **152** |
   | child-row-policies fixade | **nej** |

   Alla sex säkerhetsfynd är alltså levande i produktion.

**Rätt sekvens.** Använd reconcilerns per-fil-klassificering, aldrig
`mark-through`, och verifiera de ersättande migrationerna på innehåll:

```bash
SUPABASE_DB_URL=... npm run db:ledger:reconcile          # dry run
# Granska varje APPLIED_BUT_UNRECORDED manuellt. Migrationer som bara
# ERSÄTTER objekt måste kontrolleras på innehåll, inte existens.
SUPABASE_DB_URL=... npm run db:ledger:reconcile:apply    # skriver bara verifierade
npm run db:migrate                                        # applicerar resterande
npm run check:migrations:db
```

Verifierat läge 2026-08-09 (443 filer, ledger 358 rader, fingerprint matchar):

| Klass | Antal |
|---|---:|
| RECORDED | 358 |
| APPLIED_BUT_UNRECORDED (objekt verifierade) | 66 |
| SUPERSEDED (orsak verifierad för hand) | 2 |
| AMBIGUOUS (skapar inget detekterbart objekt) | 14 |
| NOT_APPLIED | 2 |
| PARTIAL | 1 |
| CHECKSUM_MISMATCH | **0** |

De 14 AMBIGUOUS är seed-/GRANT-/ALTER-only-filer. Nio av dem är
remediation-migrationer som måste köras. `20260807160000` är PARTIAL: dess två
bank-unikhetsindex saknas.

**Ingen ledger-rad får skrivas för en fil vars effekt inte är verifierad i
databasen.** Det är den enda regeln som betyder något här.

## 2. EXTERNA ÅTGÄRDER (kräver en människa)

1. **Leaked-password protection.** Endast via dashboarden, inte via SQL eller
   det management-API som finns här. Supabase Dashboard → Authentication →
   Policies → Password protection → aktivera *"Check passwords against
   HaveIBeenPwned"* för projekt `rpajvvngvcutffwucbdy`.

2. **Branch protection på `main` går inte att konfigurera.** Repot är privat på
   GitHub Free, och både `/rulesets` och `/branches/main/protection` svarar
   403 *"Upgrade to GitHub Pro or make this repository public to enable this
   feature."* Det är en plangräns, inte en behörighetsgräns — ingen
   konfiguration hjälper förrän planen ändras eller repot blir publikt. Fram
   till dess är CI rådgivande: den kan inte krävas.

## 3. Kvarvarande produktarbete (oförändrat)

- Samlad produktionsroute som både länkar och vid behov bokar betalning av
  migrerade AR/AP-poster atomiskt.
- Import av äldre kontoutdrag till radnivå (parser/UI).
- Fullständigt fält-för-fält merge-UI mot Bolagsverket-snapshot.

## 4. Skuld som är ratchetad, inte löst

Tre kampanjer räknas ned av `npm run check:guards`; ingen av dem blockerar
release, och ingen av dem får växa:

| Ratchet | Kvar |
|---|---:|
| `raw-route-auth` — routes som hand-rullar `getUser()` i stället för MFA-vakten | 167 |
| `naive-ore-round` — `Math.round(x*100)/100` i stället för `roundOre()` | 637 |
| `adhoc-error-envelope` — routes som returnerar `{ error: 'text' }` i stället för kuvertet | 208 |
