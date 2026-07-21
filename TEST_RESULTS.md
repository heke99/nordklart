# Faktisk verifiering i leveransmiljön

## Godkänt

- `npm ci --no-audit --no-fund`: godkänd, 1120 paket installerades.
- ESLint på samtliga ändrade TS/TSX/JS-filer: 0 fel, 20 varningar.
- `npm run check:guards`: godkänd.
- `npm run check:feature-policy`: godkänd, 459 routefiler och 289 operationer granskade.
- Riktad unit-svit: 9 testfiler, 156/156 tester godkända.
- Äldre AR/AP-ledgermockar efter adapterfix: 2 testfiler, 29/29 tester godkända.

Den riktade sviten täcker bland annat:

- periodåtkomst och tomt läge;
- manipulerat `company_id`;
- engångsbokslut;
- SIE-import och uttryckligt 3741-godkännande;
- databasverifierat FX-underlag;
- K2-radmodell för PDF/iXBRL;
- rapportpagination med 2 500 rader.

## Inte slutligt godkänt i leveransmiljön

- `npm run typecheck`: processen skrev inga typfel men nådde körgränsen och gav ingen slutsummering.
- `npm run check:lint`: nådde körgränsen och gav ingen slutsummering.
- `npm run test`: startade och passerade många sviter. Den hann hitta äldre AR/AP-mockfel; dessa rättades och omkördes grönt, men hela sviten hann inte avslutas inom körgränsen.
- PostgreSQL/PG/RLS/concurrency: kunde inte köras eftersom `psql` och lokal PostgreSQL saknas i leveransmiljön.
- `npm run build`: inte slutligt omkörd efter den kompletta v2-rekonstruktionen.

Patchen ska därför verifieras med kommandona i `SYNC_AND_VERIFY.md` innan merge eller produktion.
