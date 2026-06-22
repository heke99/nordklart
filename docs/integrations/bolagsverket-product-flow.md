# Bolagsverket / Värdefulla datamängder produktflöde

Nordklart använder Bolagsverket som grundkälla för företagsidentitet, inte som källa för bokföringsmetod eller momsperiod.

## Signup

1. Användaren skriver organisationsnummer först.
2. `/api/public/company-lookup` anropar Bolagsverket när `BOLAGSVERKET_*` finns i Vercel.
3. Formuläret fyller bolagsnamn, adress, bolagsform och SNI när registeruppgifter hittas.
4. Signup får fortsätta manuellt om Bolagsverket inte är tillgängligt.
5. Lookup-token innehåller bara normaliserade, publika fält. Raw payload hämtas/sparas server-side vid settings sync.

## Företagsinställningar

1. `GET /api/company-registry/bolagsverket/snapshot` visar senaste snapshot.
2. `POST /api/company-registry/bolagsverket/sync` hämtar aktuella uppgifter och sparar snapshot.
3. `applySafeFields=true` uppdaterar endast säkra fält: företagsnamn, adress, postnummer och ort.
4. Organisationsnummer, bokföringsmetod, momsmetod, momsperiod, F-skatt och arbetsgivarstatus ändras inte automatiskt av Bolagsverket-flödet.

## Lokal utveckling

Credentials finns bara i Vercel. Lokalt ska provider därför returnera `available=false` och UI ska falla tillbaka till manuell ifyllnad.

## Production env

```env
BOLAGSVERKET_ENVIRONMENT=production
BOLAGSVERKET_CLIENT_ID=...
BOLAGSVERKET_CLIENT_SECRET=...
BOLAGSVERKET_TOKEN_URL=https://portal.api.bolagsverket.se/oauth2/token
BOLAGSVERKET_API_BASE_URL=https://gw.api.bolagsverket.se/vardefulla-datamangder/v1
BOLAGSVERKET_SCOPES=vardefulla-datamangder:read vardefulla-datamangder:ping
```
