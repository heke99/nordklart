# Bolagsverket: företagsuppslag i Nordklart

Nordklart har nu ett provider-gränssnitt, en rate-limitad publik lookup-route och
spårbarhetsfält i signup-utkastet. Ingen extern registerdata hämtas förrän
Bolagsverket har lämnat Nordklarts faktiska anslutningsuppgifter och tekniska
specifikation för rätt API-miljö.

## Säker aktivering efter godkännande

1. Lägg endast Bolagsverkets hemligheter i Vercel Environment Variables.
2. Implementera den dokumenterade autentiseringsmetoden i
   `lib/company-registry/provider.ts`; gissa aldrig URL, certifikatformat eller
   headers.
3. Aktivera bara organisationsnummeruppslag från servern via
   `POST /api/public/company-lookup`.
4. Behåll exakt matchning mellan inmatat och returnerat organisationsnummer.
5. Mappa ett avslutat, likviderat eller oklart bolag till `ceased` respektive
   `manual_review`; autoaktivera aldrig ett sådant bolag.
6. Spara registerbilden med källa, tidpunkt och användarens eventuella manuella
   ändringar. Skatteverkets uppgifter lagras separat senare efter behörigt
   samtycke/ombud.

## Det som inte får göras

- Ingen TIC-fallback.
- Ingen API-nyckel, klienthemlighet eller certifikat i browsern, Git eller
  Supabase-tabeller.
- Ingen automatisk moms-, F-skatt- eller arbetsgivarinställning från
  Bolagsverkets grunddata.
- Ingen registrering baserad på en ungefärlig träff.
