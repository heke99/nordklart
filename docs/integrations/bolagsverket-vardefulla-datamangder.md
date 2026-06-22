# Bolagsverket Värdefulla datamängder

Nordklart uses Bolagsverket Värdefulla datamängder for company registry enrichment during signup, onboarding and company settings.

## Production defaults

The production API defaults are built into the integration:

```env
BOLAGSVERKET_ENVIRONMENT=production
BOLAGSVERKET_TOKEN_URL=https://portal.api.bolagsverket.se/oauth2/token
BOLAGSVERKET_API_BASE_URL=https://gw.api.bolagsverket.se/vardefulla-datamangder/v1
BOLAGSVERKET_SCOPES=vardefulla-datamangder:read vardefulla-datamangder:ping
BOLAGSVERKET_AUTH_METHOD=post
```

Only the client credentials must be supplied as secrets:

```env
BOLAGSVERKET_CLIENT_ID=...
BOLAGSVERKET_CLIENT_SECRET=...
```

Do not include a trailing dot in `BOLAGSVERKET_TOKEN_URL`. The runtime still trims trailing dots and slashes to protect production deployments from copy/paste mistakes.

## Accept2/test configuration

Accept2 is supported with Bolagsverket's documented URLs:

```env
BOLAGSVERKET_ENVIRONMENT=accept2
BOLAGSVERKET_CLIENT_ID_ACCEPT2=...
BOLAGSVERKET_CLIENT_SECRET_ACCEPT2=...
BOLAGSVERKET_TOKEN_URL_ACCEPT2=https://portal-accept2.api.bolagsverket.se/oauth2/token
BOLAGSVERKET_API_BASE_URL_ACCEPT2=https://gw-accept2.api.bolagsverket.se/vardefulla-datamangder/v1
```

If the environment-specific variables are not set, the generic variables are used.

## Auth

Bolagsverket's connection guide documents OAuth2 Client Credentials with `application/x-www-form-urlencoded` body credentials:

```text
grant_type=client_credentials
client_id=<client id>
client_secret=<client secret>
scope=vardefulla-datamangder:read vardefulla-datamangder:ping
```

The integration therefore defaults to `BOLAGSVERKET_AUTH_METHOD=post`. `basic` is still available as an explicit override, and `auto` can be used for troubleshooting to try `post` first and then `basic` on 401/403.

## Endpoints used

- `GET /isalive` for availability checks. Requires `vardefulla-datamangder:ping`.
- `POST /organisationer` for company profile lookup. Requires `vardefulla-datamangder:read`.
- `POST /dokumentlista` for available annual reports. Requires `vardefulla-datamangder:read`.
- `GET /dokument/{dokumentId}` for annual report ZIP download. Requires `vardefulla-datamangder:read`.

## Diagnostics

Authenticated users with write access to the active company can call:

```text
GET /api/company-registry/bolagsverket/diagnostics
```

The response shows configuration state, token status and `/isalive` status without exposing client secrets. Use this before changing signup or settings UI when Bolagsverket returns unavailable.

The public health route stays safe:

```text
GET /api/company-registry/bolagsverket/health
```

It only returns availability, environment, reason/status/request id and no credentials or raw token payload.

## What this does not provide

Värdefulla datamängder does not provide Nordklart's full accounting setup. VAT accounting method, invoice method/cash method, fiscal-year choices, Skatteverket submissions, tax account data and bank account ownership must still come from onboarding, Skatteverket or bank integrations.
