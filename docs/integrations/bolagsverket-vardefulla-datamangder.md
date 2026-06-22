# Bolagsverket Värdefulla datamängder

Nordklart uses Bolagsverket Värdefulla datamängder for company registry enrichment during signup and onboarding.

## Production defaults

The production API defaults are built into the integration:

```env
BOLAGSVERKET_ENVIRONMENT=production
BOLAGSVERKET_TOKEN_URL=https://portal.api.bolagsverket.se/oauth2/token
BOLAGSVERKET_API_BASE_URL=https://gw.api.bolagsverket.se/vardefulla-datamangder/v1
BOLAGSVERKET_SCOPES="vardefulla-datamangder:read vardefulla-datamangder:ping"
```

Only the client credentials must be supplied as secrets:

```env
BOLAGSVERKET_CLIENT_ID=...
BOLAGSVERKET_CLIENT_SECRET=...
```

Do not include a trailing dot in `BOLAGSVERKET_TOKEN_URL`.

## Accept2/test configuration

The client also supports an accept2 environment when Bolagsverket provides test URLs:

```env
BOLAGSVERKET_ENVIRONMENT=accept2
BOLAGSVERKET_CLIENT_ID_ACCEPT2=...
BOLAGSVERKET_CLIENT_SECRET_ACCEPT2=...
BOLAGSVERKET_TOKEN_URL_ACCEPT2=...
BOLAGSVERKET_API_BASE_URL_ACCEPT2=...
```

If the environment-specific variables are not set, the generic variables are used.

## Auth

The integration uses OAuth2 Client Credentials with `grant_type=client_credentials` and sends credentials using HTTP Basic auth by default.

If Bolagsverket requires client credentials in the form body instead, set:

```env
BOLAGSVERKET_AUTH_METHOD=post
```

## Endpoints used

- `GET /isalive` for availability checks.
- `POST /organisationer` for company profile lookup.
- `POST /dokumentlista` for available annual reports.
- `GET /dokument/{dokumentId}` for annual report ZIP download.

## What this does not provide

Värdefulla datamängder does not provide Nordklart's full accounting setup. VAT accounting method, invoice method/cash method, fiscal-year choices, Skatteverket submissions, tax account data and bank account ownership must still come from onboarding, Skatteverket or bank integrations.
