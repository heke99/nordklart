# Company authorization and access control

This batch separates company data discovery from company authorization. Bolagsverket can prefill company data, but it never grants access to a Nordklart workspace.

## Core rule

A user may access a company only through one of these server-side sources:

1. Founder signup for a company that does not already exist in Nordklart.
2. Accepted company invitation from an existing owner/admin.
3. Approved company access request from an existing owner/admin.
4. Agency access, where the agency-client relation is active.
5. Platform admin access.

Knowing an organisation number is not enough to access or create a duplicate workspace.

## Membership lifecycle

`company_members` now has an authorization lifecycle:

- `status = active`: full membership according to role.
- `status = active_limited`: read/onboarding access only; write/admin actions are blocked.
- `status = pending`: created but not approved yet.
- `status = suspended`: temporarily blocked.
- `status = revoked`: historical membership, no access.

`access_source` records why the user has access:

- `founder_signup`
- `invite`
- `access_request`
- `agency`
- `platform_admin`
- `direct`

All server guards must filter membership status. Pending, suspended and revoked memberships must never count as active access.

## Signup behavior

### New organisation number

1. The user enters an organisation number.
2. Nordklart may prefill company data from Bolagsverket.
3. If the organisation number does not exist in Nordklart, provisioning creates the company and makes the user owner.
4. The membership is marked `active`, `access_source = founder_signup`, and `verification_status = self_attested`.
5. A `company_authorization_attestations` row is created as an audit trail.

### Existing organisation number

1. The user enters an organisation number.
2. If the organisation number already exists in Nordklart, provisioning does not create a duplicate company.
3. The system creates or reopens a `company_access_requests` row.
4. The signup draft moves to `access_request_pending`.
5. The user is sent to `/access-pending` until an owner/admin approves or rejects the request.

## Access request approval

Owners/admins can approve pending requests from company settings.

Approval creates or updates `company_members` with:

- `status = active`
- `access_source = access_request`
- `approved_by = current user`
- `approved_at = now()`

The request row is updated to `approved`. Rejecting changes the request to `rejected` and keeps the user out of the workspace.

## Invitations

Invitations remain the preferred path when an owner/admin intentionally adds a user. Accepting an invitation creates an active membership with:

- `access_source = invite`
- `approved_by = invited_by`
- `approved_at = now()`
- `accepted_by` and `accepted_at` on the invitation row

## Guard expectations

Read access can use active or active-limited memberships. Write/admin actions must require `status = active`.

Do not trust:

- company_id from frontend
- role from frontend
- organisation number alone
- Bolagsverket lookup response as proof of authority

Always derive access from `auth.user.id` and server-side membership/access records.
