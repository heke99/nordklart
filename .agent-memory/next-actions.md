# Nästa exakta åtgärder

Uppdaterad 2026-08-08, efter remediation-branchen
`claude/nordklart-remediation-hardening-lbyqtt` (PR #7).

Allt som tidigare stod här — pg-real grönt, H-03-atomiciteten,
testmatriserna, redefinitionsgranskningen — är gjort. Det som återstår är
deploy och två saker som kräver en människa.

## 1. Deploya branchen till produktion, i rätt ordning

Produktion ligger **efter** repot. `db:migrate` får inte köras först: den
skulle försöka applicera om de 69 filer som redan är applicerade men
oregistrerade. Ordningen finns i sin helhet i
`docs/audits/2026-08-08-supabase-advisors-and-ledger.md`.

```bash
# 1. Registrera det som redan är applicerat, fram till sista filen i produktion.
npm run db:migrate:mark-through -- 20260801140000_production_financial_atomicity_and_billing_lifecycle.sql

# 2. Bekräfta att liggaren nu beskriver databasen (bara branchens migrationer kvar).
SUPABASE_DB_URL=... npm run db:ledger:reconcile

# 3. Applicera branchens migrationer.
npm run db:migrate

# 4. Verifiera.
npm run check:migrations:db
SUPABASE_DB_URL=... npm run db:ledger:reconcile   # noll i allt utom RECORDED
```

Steg 1 är en avsiktlig skrivning mot produktionens migrationsauktoritet.
`--apply` är aldrig default, och sekvensen har inte körts härifrån.

**Verifiera efter deploy** — fynden är inte åtgärdade i produktion förrän
migrationerna är körda:

```sql
-- #17: fyra vyer får inte längre kringgå RLS
SELECT c.relname, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='v'
   AND c.relname IN ('customer_ar_balances','company_commercial_usage_v',
                     'agency_commercial_usage_v','company_effective_commercial_limits_v');

-- #18 + anon-hålet: anon får inte ha EXECUTE
SELECT has_function_privilege('anon','public.commit_journal_entry(uuid,uuid,text,text,text,text)','EXECUTE');

-- #19: inga write-policies kvar på enbart medlemskap (utom de tre ägarskopade)
SELECT tablename, cmd FROM pg_policies
 WHERE schemaname='public' AND cmd IN ('INSERT','UPDATE','DELETE')
   AND (coalesce(qual,'')||coalesce(with_check,'')) LIKE '%user_company_ids() AS user_company_ids%'
   AND (coalesce(qual,'')||coalesce(with_check,'')) NOT LIKE '%user_can_write_company%'
   AND (coalesce(qual,'')||coalesce(with_check,'')) NOT LIKE '%user_id = auth.uid()%';
```

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
