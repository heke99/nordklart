# Nordklart commercial plan and agency model

This batch turns the existing commercial foundation into a production-oriented model for two audiences:

1. **Company workspaces**: limited companies and sole traders.
2. **Agency workspaces**: accounting and audit agencies that manage multiple client companies.

Nordklart remains the source of truth for what a plan means. Stripe only confirms payment, invoice status and immutable price ids.

## Core rules

- Every paid plan includes bookkeeping and year-end foundations.
- Plans differ by capacity and advanced modules: users, external advisors, payroll employees, agency clients, agency staff, Bankgiro, Skatteverket flows, API and AI.
- A user gets access through membership and role.
- A company or agency gets product capacity through subscription entitlements and limits.
- An agency gets client access through `agency_clients` and active agency staff membership.

## Commercial taxonomy

`platform_products` contains product families:

- `company_accounting`
- `agency_accounting`
- `commercial_addons`

`platform_price_plans` now carries public and commercial metadata:

- `audience_type`: `company`, `agency`, `addon`, `internal`
- `company_form_scope`: `limited_company`, `sole_trader`, `company_all`, `agency`, `not_applicable`
- `is_public`
- public name, summary, badge, sort order and CTA

`platform_plan_versions` still carries the immutable commercial price version.

`platform_plan_version_features` remains the entitlement source and now includes standard limit feature keys.

## Standard limit feature keys

- `company.users`
- `external.advisors`
- `payroll.employees`
- `agency.clients`
- `agency.staff`

Other important product feature keys:

- `bookkeeping.automation`
- `vat.reports`
- `skatteverket.submissions`
- `salary.runs`
- `agency.client_portal`
- `agency.review_queue`
- `agency.deadlines`
- `api.access`
- `ai.assistant`

## Public pricing

`public_price_plans_v` is the read model for `/priser`. It only exposes active, public plans with an active current version and includes features/limits as JSON.

The public pricing page must not be hardcoded. It reads:

- company plans
- agency plans
- price-from labels
- limits and key included features

## Limit enforcement

Application code should use:

- `lib/platform/entitlement-limits.ts`
- `company_commercial_limit(company_id, feature_code)`
- `company_feature_usage(company_id, feature_code)`

Important checks:

- Invite internal company user → `company.users`
- Invite external accountant/auditor/viewer → `external.advisors`
- Add payroll employee → `payroll.employees`
- Create agency client → `agency.clients`
- Invite/add agency staff → `agency.staff`

## Direct advisor/auditor model

A company may invite an external accountant or auditor directly through `company_members`:

- `role = accountant` or `auditor`
- `membership_kind = external`
- `access_source = invite` or `access_request`
- `status = active`

These users count against `external.advisors`.

## Agency model

An agency workspace is linked to its own company via `agencies.company_id`. Its subscription controls agency capacity.

Agency client relations use `agency_clients`:

- `billing_owner`: `agency`, `client`, `shared`
- `access_level`: `bookkeeping`, `review`, `audit`, `full_service`
- `status`: `pending`, `active`, `paused`, `suspended`, `ended`

Agency staff use `agency_members` with active status and agency roles.

## Superadmin responsibilities

Superadmin configures:

- products
- plans
- public metadata
- price versions
- included features
- limits
- Stripe mapping
- manual subscriptions and complimentary grants

Public pricing and entitlement guards should then follow the configured database model without code changes.
