# Kända begränsningar och produktionsblockerare

## Måste lösas före produktionsgodkännande

1. De tre migrationerna har inte applicerats eller körts i denna miljö eftersom
   `SUPABASE_DB_URL`/`DATABASE_URL` saknas.
2. pg-real-, RLS-, concurrency- och end-to-end-bokslutstester har inte kunnat
   köras. Lokalt PostgreSQL-försök gav `ECONNREFUSED` på port 5432.
3. Källprojektet innehåller redan två dubbla migrationsversioner:
   `20260629120000` och `20260704120000`. De ska inte döpas om om de redan har
   applicerats. Målmiljöns migrationshistorik måste avstämmas före push.

## Funktionella avgränsningar

4. Datamodellen har betalningstabeller och spärrar mot dubbelanvändning,
   överbetalning samt både länkning och nybokföring. En enda komplett
   produktionsroute/RPC som atomiskt bokför eller länkar alla varianter av
   migrerad AR/AP-betalning är ännu inte implementerad.
5. Historisk bank har schema, dokumentation, länkar och manuell
   balansverifiering. Full parser och radbaserat UI för import av äldre
   kontoutdrag är ännu inte implementerade.
6. Företagssnapshoten kan låsa periodens aktuella profil och årsredovisningen
   använder den låsta versionen. UI för fältvis val mellan SIE, Nordklart-profil,
   registeruppgift och vald bokslutsuppgift är ännu inte komplett.

## Konsekvens

Leveransen löser de centrala identitets-, status-, arkiv-, stödregister-,
kontroll-, årsredovisnings- och stängningsproblemen, men uppfyller inte ärligt
varje obligatoriskt betalnings-, bankimport- och snapshot-acceptanstest ännu.
Produktionsmerge bör därför villkoras av databasverifieringen och de tre
funktionella kompletteringarna ovan.
