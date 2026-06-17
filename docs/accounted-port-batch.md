# Nordklart portningsbatch — Accounted → Nordklart

Den här batchen portar säkra delar från Accounted utan att ändra Nordklarts bokföringsregler eller återinföra XLSX/Excel-export.

## Byggt

- Artikelregister för fakturarader, utan lagerbokföring.
- Periodiseringsfoundation med `accrual_schedules` och `accrual_schedule_installments`.
- `source_type = 'accrual'` i verifikationer så periodiseringar går genom befintlig bokföringsmotor.
- iXBRL/K2-grund och Bolagsverket extension-filer, rebrandade till Nordklart.
- Feature-gate helpers för entitlements och bokslutsaccess.
- Produkt-/plan-/feature-/entitlement-tabeller.
- Engångsköp för bokslut.
- Year-end project-tabeller.
- Bankgiro/Autogiro onboarding-tabeller som separat modul.
- API-scope- och webhook-tabeller.
- XLSX-exporter är avstängda med 410-svar.

## Regler som ska bevaras

- Debet/kredit måste balansera.
- VAT/moms periodiseras inte; bara nettointäkt/nettokostnad flyttas till interimskonto.
- Låsta perioder ska inte ändras tyst.
- Postade periodiseringsrader är immutabla.
- Artikeländringar flyttar aldrig redan skapade faktura-/bokföringsrader.
- iXBRL är gated via `year_end.ixbrl` eller bokslutsköp/åtkomst.

## Supabase SQL

Kör migrationerna i Supabase SQL Editor eller via Supabase migrations i denna ordning:

1. `supabase/migrations/20260624120000_nordklart_articles_accruals_ixbrl_foundation.sql`
2. `supabase/migrations/20260624121000_nordklart_products_entitlements_year_end_bankgiro_api.sql`

De är idempotenta med `create table if not exists`, `drop policy if exists` och `on conflict` där seed-data används.

## XLSX

XLSX är inte borttaget ur historiken i denna patch, men alla befintliga `/xlsx` report-routes returnerar nu 410 och helpern har ingen runtime import av `write-excel-file`/`xlsx`. Nästa separata cleanup kan ta bort dependency från `package.json/package-lock` om ni vill städa dependency-trädet helt.
