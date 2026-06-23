# Nordklart Commercial Completion Patch — testlista

Den här patchen stänger kvarvarande kommersiella luckor efter företags-/byråplaner, add-ons, limits och platform/company-växling.

## SQL

1. Kör migrationen `20260701120000_nordklart_commercial_completion_patch.sql`.
2. Kontrollera att migrationen är idempotent genom att köra den en gång till i staging.
3. Kontrollera att följande add-on-planer finns som `audience_type = addon` och `is_public = false`:
   - `addon_extra_company_user`
   - `addon_extra_external_advisor`
   - `addon_extra_payroll_5_employees`
   - `addon_extra_agency_10_clients`
   - `addon_extra_agency_staff`
   - `addon_bankgiro_operations`
   - `addon_api_webhooks`
   - `addon_ai_automation`
4. Kontrollera att `company_effective_commercial_limits_v` visar rätt usage/limit för:
   - `company.users`
   - `external.advisors`
   - `payroll.employees`
   - `agency.clients`
   - `agency.staff`

## Add-on quantity

1. Ge en byrå `agency_plus` med `agency.clients = 25`.
2. Lägg till `addon_extra_agency_10_clients` med quantity `2`.
3. Kontrollera att effektiv limit för `agency.clients` blir `45`.
4. Upprepa med:
   - `addon_extra_company_user` × 3 → +3 `company.users`
   - `addon_extra_external_advisor` × 2 → +2 `external.advisors`
   - `addon_extra_payroll_5_employees` × 2 → +10 `payroll.employees`
   - `addon_extra_agency_staff` × 2 → +2 `agency.staff`

## Company invites

1. Bjud in intern bolagsanvändare när planen har ledig `company.users`-kapacitet.
2. Bjud in intern bolagsanvändare när limiten är nådd. Förväntat: HTTP 402 och tydlig upgrade-text.
3. Skicka flera pending invites och verifiera att pending invites räknas mot limiten.
4. Bjud in extern rådgivare/revisor och kontrollera att den räknas mot `external.advisors`, inte `company.users`.

## Agency staff invites

1. Anropa `POST /api/agency/staff/invite` som `agency_admin` eller `agency_owner`.
2. Verifiera att pending invite skapas i `agency_invitations`.
3. Acceptera inbjudan via `/invite/[token]`.
4. Verifiera att användaren hamnar i `agency_members` med rätt roll.
5. Verifiera att `user_preferences.active_workspace_type = agency` och `active_agency_id` sätts.
6. Försök bjuda in över `agency.staff`-limit. Förväntat: HTTP 402 och tydlig upgrade-text.

## Agency clients

1. Skapa/länka kundbolag under byrå när byrån har ledig `agency.clients`-kapacitet.
2. Skapa/länka kundbolag när limiten är nådd. Förväntat: HTTP 402.
3. Kontrollera att `ended`, `paused` och `suspended` relationer inte räknas som aktiva kunder.

## Payroll

1. Skapa anställd när `payroll.employees` har ledig kapacitet.
2. Skapa anställd när limiten är nådd. Förväntat: HTTP 402.
3. Försök skapa lönekörning när planen har `payroll.employees = 0`. Förväntat: blockerat.
4. Skapa lönekörning när usage är exakt lika med positiv limit, till exempel 5/5. Förväntat: tillåtet.
5. Kör `/api/salary/runs/[id]/calculate` och v1 `POST /salary-runs/[id]/calculate` när usage överstiger limit. Förväntat: blockerat.

## Public pricing och signup

1. Kontrollera att `/priser` bara visar `is_public = true` och `audience_type in ('company','agency')`.
2. Klicka företagsplan. Förväntat: `/register?intent=company&plan=...` och företagsflöde valt.
3. Klicka byråplan. Förväntat: `/register?intent=agency&workspace=agency&plan=...` och byråflöde valt.
4. Kontrollera att add-ons inte visas publikt.

## Platform/company/agency context switch

1. Logga in som superadmin som också är bolagsadmin.
2. Växla från Platform admin till Bolagsarbetsyta.
3. Förväntat:
   - Aktiv kontext visas tydligt.
   - Sidebar hoppar inte mellan gamla och nya grupper.
   - React transition visar spinner på växlingen.
   - `user_preferences.active_workspace_type` uppdateras.
4. Växla Bolagsarbetsyta → Byråarbetsyta → Platform admin.
5. Verifiera att navigation och permissions följer vald route/context och inte gamla prefs.

## Build

Kör:

```bash
npm run build
```

Om build faller på Supabase types för nya tabellen `agency_invitations`, regenerera typer eller kör en temporär typad cast i route innan deploy.
