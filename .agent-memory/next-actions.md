# Nästa exakta åtgärder

Uppdaterad 2026-08-12.

**Databasarbetet är klart.** Produktion och en ren replay av `origin/main` ger
identiska content-fingerprints över alla åtta objekttyper, och liggaren matchar
repot fil för fil. Det som återstår är externa plattformsinställningar och
oförändrat produktarbete.

## 1. Så här verifierar du att det fortfarande stämmer

```bash
npm run test:pg:reset                              # ren replay = canonical
node scripts/schema-fingerprint.mjs summary        # kör mot båda databaserna
```

Alla åtta rader ska vara identiska. Per 2026-08-12:

| Typ | Antal | Hash |
|---|---:|---|
| column | 4332 | `52b8643f` |
| constraint | 1843 | `4ca583ac` |
| function | 281 | `06ba2d68` |
| index | 929 | `64ea2c42` |
| policy | 635 | `db58c18d` |
| rls | 277 | `c928998a` |
| trigger | 329 | `71660424` |
| view | 27 | `0c1c9337` |

Liggaren: 450 rader, 450 filer. Manifestet `version=checksum` hashar till
`d9cbeb1c101aef36ae29cd7b8c51e5bb` på båda sidor — det är beviset att en vanlig
`db:migrate` inte replayar något och att ingen registrerad checksumma avviker
från sin fil.

**Använd content, inte objektexistens.** `reconcile-migration-ledger.mjs` frågar
om objekt *finns*. Det är sant oavsett om en ersättande migration kördes, och
det var precis så en gammal `resolve_company_access` kunde stå kvar i produktion
med hela statuskontrollen borta medan liggaren såg ren ut.

## 2. Deploy av nya migrationer

```bash
node scripts/deploy-migration-via-mcp.mjs supabase/migrations/<fil>.sql
```

Skriver ut satserna i körordning. Kör dem genom Supabase MCP `execute_sql` och
stanna på första som inte svarar `ok`. Databasen räknar om sha256 på det den tog
emot och vägrar köra om något avviker från filen på disk.

Två saker som redan har bevisat sitt värde: transporten är atomisk (en
felordnad `ALTER TABLE` rullade tillbaka utan att lämna något halvapplicerat),
och en migration som är no-op mot canonical kan ändå fela mot produktion — så
verifiera alltid **efter** varje deploy, inte bara före.

## 3. EXTERNA ÅTGÄRDER (kräver en människa)

1. **Leaked-password protection.** Supabase Dashboard → Authentication →
   Policies → aktivera *"Check passwords against HaveIBeenPwned"* för projekt
   `rpajvvngvcutffwucbdy`. Går inte via SQL eller management-API:t.

2. **Branch protection på `main`.** Privat repo på GitHub Free; `/rulesets` och
   `/branches/main/protection` svarar 403 *"Upgrade to GitHub Pro or make this
   repository public."* Plangräns, inte behörighetsgräns.

3. **GitHub Actions-minuter.** Slut. Alla grindar körs lokalt
   (`npm run verify:fast`, `npm run test:pg`) tills det ändras.

## 4. Öppen produktfråga

`signed_consents_insert` och `bolagsverket_avtal_acceptances_insert` kräver
medlemskap + `user_id = auth.uid()`, inte skrivrätt. En viewer kan alltså skapa
ett samtycke i sitt eget namn. Avsiktligt lämnat: signering är en personlig
handling, och att kräva skrivrätt på personliga rader låste ute revisorer från
assistenten en gång redan. Om signering ska binda bolaget hör kravet hemma i
routen som begär signaturen. Behöver ett produktbeslut.

## 5. Kvarvarande produktarbete (oförändrat)

- Samlad produktionsroute som både länkar och vid behov bokar betalning av
  migrerade AR/AP-poster atomiskt.
- Import av äldre kontoutdrag till radnivå (parser/UI).
- Fullständigt fält-för-fält merge-UI mot Bolagsverket-snapshot.

## 6. Skuld som är ratchetad, inte löst

Räknas ned av `npm run check:guards`; ingen blockerar release, ingen får växa.

| Ratchet | Kvar |
|---|---:|
| `raw-route-auth` | 167 |
| `naive-ore-round` | 637 |
| `adhoc-error-envelope` | 208 |
| `service-role-surface` | 108 |
