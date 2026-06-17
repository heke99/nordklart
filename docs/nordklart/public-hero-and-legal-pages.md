# Nordklart public hero and legal pages

This batch turns the first visitor experience into a public marketing/hero site instead of sending unauthenticated users directly to login.

## Public routes

- `/` — public hero/start page
- `/dashboard` — public hero alias
- `/bokforing` — bookkeeping page
- `/bokslut` — standalone year-end closing page
- `/bankgiro` — Bankgiro via partner page
- `/byra` — accounting agency page
- `/priser` — product/pricing paths without invented fixed prices
- `/kontakt` — contact page
- `/boka-demo` — demo page
- `/allmanna-villkor` — general terms placeholder
- `/integritetspolicy` — privacy policy placeholder
- `/cookies` — cookie information
- `/personuppgifter` — personal data information

## App routes

- `/login` remains login.
- `/app` is the authenticated in-app overview/dashboard.
- Existing login/auth redirects now send signed-in users to `/app` instead of `/`.

## Product message

The hero page presents four clear entry paths:

1. Start bookkeeping.
2. Do only year-end closing as a separate flow.
3. Apply for Bankgiro via partner and connect it to payments, reconciliation and bookkeeping.
4. Use everything in one connected system.

## Constraints kept

- No XLSX/Excel export added.
- No new dependencies.
- No Supabase migration added.
- Public pages are server-rendered and use static marketing content only.
