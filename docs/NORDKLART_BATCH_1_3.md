# Nordklart Batch 1–3

## Batch 1 — Proprietär Nordklart foundation

Genomfört:

- Projektet är omdöpt till `nordklart`.
- Standardbranding är `Nordklart`.
- Tidigare licens-/community-positionering i den egna projektkoden är ersatt med proprietär licens.
- `LICENSE`, `NOTICE` och `README.md` beskriver nu Nordklart som en proprietär SaaS-produkt.
- Tidigare projektbranding är ersatt i användarsynliga och centrala tekniska ytor.
- Interna nya prefix är Nordklart-orienterade, t.ex. `nordklart-company-id`, `nordklart-invite-token`, `nordklart_sk_`.

Bevarat:

- Bokföringsmotorn ändras inte i denna batch.
- Dubbel bokföring, låsta perioder, verifikationslogik, SIE, moms och rapporter påverkas inte.
- Tredjepartsdependencies behåller sina egna licenser.

## Batch 2 — Ny designbas och navigation

Genomfört:

- Ny Nordklart-färgpalett i `app/globals.css`.
- Ny modern sidebar i `components/dashboard/DashboardNav.tsx`.
- Tydligare navigation för:
  - Arbetsyta
  - Bokföring
  - Nordklart
- Ny mobilmeny.
- Ny dashboard-container med bredare SaaS-layout.
- Nya återanvändbara Nordklart-komponenter:
  - `NordklartPageShell`
  - `NordklartStatCard`
  - `NordklartActionCard`
- Nya plattforms-/byråsidor som visar den nya produktkänslan.

Designprincip:

- Färre tekniska ord.
- Mer arbetsflöde än funktionsdjungel.
- Tydlig uppdelning mellan företag, byrå och plattform.
- Enklare att bygga vidare med prisplaner, onboarding och automation.

## Batch 3 — Multi-tenant och byrågrund

Genomfört via migration:

- `platform_roles`
- `agencies`
- `agency_members`
- `agency_clients`
- `company_access` view
- `is_platform_admin()`
- `user_is_agency_member()`
- `user_is_agency_admin()`
- `user_can_access_company_v2()`
- RLS-policies för nya tabeller
- Index för snabb accesskontroll
- Backfill från befintliga `teams`, `team_members` och `companies.team_id`

Genomfört i TypeScript:

- Nya typer för platform roles, agencies, agency members, agency clients och company access.

Nya sidor:

- `/agency`
- `/platform`

Viktig princip:

Den gamla `company_members`-modellen finns kvar. Batch 3 lägger en byråmodell ovanpå den utan att förstöra befintlig company access eller bokföringsdata.
