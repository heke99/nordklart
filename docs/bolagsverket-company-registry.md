# Bolagsverket: företagsuppslag i Nordklart

Nordklart använder Bolagsverket Värdefulla datamängder som server-side provider för företagsuppslag i signup, onboarding och företagsinställningar.

## Säker aktivering

1. Lägg endast Bolagsverkets hemligheter i Vercel Environment Variables.
2. Använd OAuth2 Client Credentials enligt Bolagsverkets anslutningsguide: `client_id`, `client_secret`, `grant_type` och `scope` skickas som `application/x-www-form-urlencoded` body.
3. Aktivera organisationsnummeruppslag endast från servern via `POST /api/public/company-lookup`.
4. Behåll exakt matchning mellan inmatat och returnerat organisationsnummer.
5. Mappa ett avslutat, likviderat eller oklart bolag till `ceased` respektive `manual_review`; autoaktivera aldrig ett sådant bolag.
6. Spara registerbilden med källa, tidpunkt och användarens eventuella manuella ändringar. Skatteverkets uppgifter lagras separat senare efter behörigt samtycke/ombud.

## Diagnostik

Använd `GET /api/company-registry/bolagsverket/diagnostics` som inloggad användare med skrivbehörighet i aktivt företag. Svaret visar tokenstatus och `/isalive`-status utan att exponera client secret.

Den publika health-routen `GET /api/company-registry/bolagsverket/health` visar bara tillgänglighet, miljö och säker felkod/status.

## Det som inte får göras

- Ingen TIC-fallback.
- Ingen API-nyckel, klienthemlighet eller certifikat i browsern, Git eller Supabase-tabeller.
- Ingen automatisk moms-, F-skatt- eller arbetsgivarinställning från Bolagsverkets grunddata.
- Ingen registrering baserad på en ungefärlig träff.
