# Nästa exakta åtgärder

Uppdaterad 2026-08-10, efter att produktionsdeployen slutfördes.

Deploykön är tom. Repot och produktion är i samma tillstånd — se
`open-blockers.md` för den verifierade matrisen.

## 1. Historisk ledger-reconciliation (enda kvarvarande DB-arbetet)

444 filer i repot, **376** rader i liggaren. De 68 utan rad är verifierat
applicerade sedan tidigare — fingerprint-matchade mot live med
CHECKSUM_MISMATCH = 0 — men raderna är aldrig skrivna.

**Metod:** en fil i taget, med fotavtrycket verifierat innan raden skrivs.

```
node scripts/reconcile-via-catalog.mjs probes --ledger <ledger.json> > probes.sql
# kör probes.sql mot produktion, spara svaret som presence.json
node scripts/reconcile-via-catalog.mjs classify --ledger <ledger.json> --presence presence.json
```

**Kör ALDRIG `db:migrate:mark-through`.** Den markerar ett *intervall*, och den
kan inte avgöra om en *ersättande* migration (`CREATE OR REPLACE FUNCTION`,
`DROP/CREATE POLICY` med samma namn) faktiskt körts — objektet finns oavsett.
Den sekvensen hade markerat varje säkerhetsmigration som applicerad medan
produktionen förblev exploaterbar, och den hade svept in
`20260712120000_invoice_financing.sql` som var helt oapplicerad.

## 2. Deploy av nya migrationer

Ingen rå connection string finns här. Använd filtransporten:

```
node scripts/deploy-migration-via-mcp.mjs supabase/migrations/<fil>.sql
```

Den skriver ut satserna i körordning. Kör dem i ordning genom Supabase MCP
`execute_sql` och stanna på första som inte svarar `ok`. Databasen räknar om
sha256 på det den tog emot och vägrar köra om något avviker från filen på disk.
Skriv aldrig av en migration för hand utan den kontrollen.

## 3. Öppen produktfråga

`signed_consents_insert` och `bolagsverket_avtal_acceptances_insert` kräver
medlemskap + `user_id = auth.uid()`, inte skrivrätt. En viewer kan alltså skapa
ett samtycke i sitt eget namn. Det är avsiktligt lämnat: signering är en
personlig handling, och att kräva skrivrätt på personliga rader låste ute
revisorer från assistenten en gång redan. **Om signering ska binda bolaget bör
kravet ligga i routen som begär signaturen**, inte i ett policysvep. Behöver ett
produktbeslut.

## 4. EXTERNA ÅTGÄRDER (kräver en människa)

1. **Leaked-password protection.** Supabase Dashboard → Authentication →
   Policies → Password protection → aktivera *"Check passwords against
   HaveIBeenPwned"* för projekt `rpajvvngvcutffwucbdy`. Går inte via SQL eller
   management-API:t härifrån.

2. **Branch protection på `main`.** Privat repo på GitHub Free; både
   `/rulesets` och `/branches/main/protection` svarar 403 *"Upgrade to GitHub
   Pro or make this repository public."* Plangräns, inte behörighetsgräns. Tills
   planen ändras är CI rådgivande och kan inte krävas för merge.

3. **GitHub Actions-minuter.** Slut. Alla grindar körs lokalt
   (`npm run verify:fast`, `npm run test:pg`) tills det ändras.

## 5. Kvarvarande produktarbete (oförändrat)

- Samlad produktionsroute som både länkar och vid behov bokar betalning av
  migrerade AR/AP-poster atomiskt.
- Import av äldre kontoutdrag till radnivå (parser/UI).
- Fullständigt fält-för-fält merge-UI mot Bolagsverket-snapshot.

## 6. Skuld som är ratchetad, inte löst

Räknas ned av `npm run check:guards`; ingen blockerar release, ingen får växa.

| Ratchet | Kvar |
|---|---:|
| `raw-route-auth` — routes som hand-rullar `getUser()` i stället för MFA-vakten | 167 |
| `naive-ore-round` — `Math.round(x*100)/100` i stället för `roundOre()` | 637 |
| `adhoc-error-envelope` — routes som returnerar `{ error: 'text' }` | 208 |
| `service-role-surface` — filer som konstruerar service-role-klient | 108 |
