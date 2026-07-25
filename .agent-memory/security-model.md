# Säkerhetsmodell

Hot som alltid ska beaktas:

- IDOR och korsbolagsåtkomst.
- MFA-bypass genom rå routeauth.
- Service-role-anrop utan tenantbegränsning.
- Felaktig feature-/planinferens som öppnar eller stänger funktioner.
- Importer, webhooks och filuppladdning med manipulerat innehåll.
- Race conditions och dubbla ekonomiska mutationer.
- Loggning av tokens, personuppgifter eller bankhemligheter.

Verifiera både positiva och negativa fall. Säkerhet på UI-nivå räknas inte som
fullgod kontroll.

