# Domänmodell

Viktiga avgränsningar:

- Användare är identiteter; företag är tenants.
- Medlemskap kopplar användare till företag med roll och behörighet.
- Planer, grants, entitlements och periodbundna engångsköp är skilda begrepp.
- Räkenskapsperioder äger periodberoende rapporter och bokslut.
- Verifikationer består av huvud och rader och får inte bryta dubbel bokföring.
- Dokument och importer är spårbara artefakter, inte bara tillfälliga filer.

Alla företagsägda rader ska ha en entydig tenantnyckel och skyddas både i
serverkod och med RLS.

