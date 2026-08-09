# Nästa exakta åtgärder

Uppdaterad 2026-08-08, efter remediation-branchen
`claude/nordklart-remediation-hardening-lbyqtt` (PR #7).

Allt som tidigare stod här — pg-real grönt, H-03-atomiciteten,
testmatriserna, redefinitionsgranskningen — är gjort. Det som återstår är
deploy och två saker som kräver en människa.

## 1. Slutför produktionsdeployen — EXAKT ORDNING

Ledger står på 360 rader. Två migrationer är deployade (se `open-blockers.md`).
Kvarstår, i repositoryordning:

| Fil | KB | Varför |
|---|---:|---|
| `20260807120000_secure_migration_ledger_and_pin_search_path.sql` | 3 | ledger-RLS + search_path |
| `20260807130000_allow_sie_import_reversal_commit_method.sql` | 2 | CHECK-vokabulär |
| `20260807140000_restore_opening_balance_retag_carveout.sql` | 6 | funktionsersättning |
| `20260807150000_restore_sie_imported_workpaper_blocker_precedence.sql` | 5 | funktionsersättning |
| `20260807160000_bank_allocation_uniqueness_per_invoice.sql` | 4 | PARTIAL — 2 index saknas |
| `20260807170000_fix_null_invalidation_flags_in_open_item_reconciliation.sql` | 10 | funktionsersättning |
| `20260807180000_allow_atomic_settlement_commit_methods.sql` | 2 | CHECK, krävs före settlement v2 |
| `20260808120000_settlement_creates_its_own_voucher.sql` | 24 | settlement v2 |
| `20260808130000_pin_search_path_on_remaining_security_definer.sql` | 2 | |
| `20260808140000_allow_system_commit_method_for_prior_result_transfer.sql` | 3 | #16 |
| `20260808160000_authorize_commit_journal_entry.sql` | 6 | **hoppa över** — helt ersatt av `20260808190000` som redan är live |
| `20260808170000_write_policies_require_write_capability.sql` | 35 | **#19** — 152 policies |
| `20260808180000_personal_assistant_rows_are_owner_scoped.sql` | 4 | |
| `20260809100000_child_row_write_policies_require_write_capability.sql` | 5 | child-rows |

Plus `20260712120000_invoice_financing.sql` (#387), helt oapplicerad — avgör
först om den fortfarande hör till canonical schema.

**Metod som fungerar och som ska återanvändas** (raw connection string saknas;
Supabase MCP `execute_sql` används som transport, semantiken är runnerns):

1. läs filen ur git, beräkna `sha256sum`,
2. kör hela filens SQL i **en** transaktion tillsammans med
   `INSERT INTO public.nordklart_schema_migrations (version, checksum, source)
   VALUES ('<filnamn>', '<sha256>', 'mcp-deploy')`,
3. postcheck som verifierar migrationens kritiska fotavtryck,
4. vid fel: STOPP, kör inte nästa fil.

**Historisk ledger-reconciliation är INTE gjord.** 66 filer är verifierat
applicerade men oregistrerade. Skriv dem fil för fil — aldrig `mark-through`,
aldrig intervall. Se `decisions.md` och varningen nedan.

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
