# Service-role additions, 2026-09-27

Each file below now constructs a service-role client. For each one: who the
actor is, how company and resource access is checked, and why the service
role is needed.

## `app/api/auth/invite-signup/route.ts` (POST)

- **Actor:** unauthenticated. The caller presents an invitation token that was
  delivered to the invited mailbox. The route is limited per IP (10 per 15 min).
- **Resource:** the invitation is looked up by the SHA-256 hash of the token.
  It must be pending and unexpired. The new account is created for exactly
  the invited e-mail (never an e-mail from the request body).
- **Permission:** `accept_invitation` repeats the status, expiry and e-mail
  checks under a row lock and grants only the role on the invitation. If the
  accept fails, the new account is deleted again.
- **Why service role:** creating a confirmed user (`auth.admin.createUser`)
  and `accept_invitation` (granted to `service_role` only) both require it.

## `app/api/agency/clients/route.ts` (POST)

- **Actor:** `requireAuth` authenticates the user and enforces MFA.
  `resolveManageableAgency` requires an active agency owner/admin membership.
- **Company and resource:** the link itself is still inserted with the
  user's RLS client. The service client is used only after a successful
  insert, to read the agency name, the client company name and the e-mails
  of that company's active owners/admins.
- **Why service role:** the agency staff member cannot read the client
  company's members through RLS before the link is approved, and those
  owners/admins are the people who must be told that a link awaits approval.
  Nothing is written.
