# Faktiskt genomförd verifiering

Datum: 2026-08-01

## Grönt

### `npm run check:guards`

Exit status: `0`

Resultat:

- antipattern-guard passerade;
- 14 färre förekomster av osäker naiv öresavrundning än baseline;
- migrationsmanifest OK: 426 filer;
- två kända äldre kollisioner markerades `reconciliation-required`;
- financial hardening contract passerade.

### TypeScript syntax-transpilering

Ett separat lokalt kontrollscript körde `typescript.transpileModule` mot samtliga 28 ändrade TypeScript-filer.

Resultat: passerade utan syntaxdiagnostik.

Detta är inte samma sak som full projekt-typkontroll.

### SQL statisk kontroll

- migrationens `$$`-avgränsare är balanserade;
- `SECURITY DEFINER` finns på de nya privilegierade funktionerna;
- statisk kontraktsguard verifierar RPC-namn, service-role-grants, Stripe-event, atomiska routes och förbjudna direkta betalningsinsert/reversal-mönster.

## Blockerat eller rött

### `npm ci --no-audit --no-fund`

Exit status: `1`

Exakt blockerare:

```text
404 Not Found - GET https://packages.applied-caas-gateway1.internal.api.openai.org/artifactory/api/npm/npm-public/zwitch/-/zwitch-2.0.4.tgz
```

Detta är ett externt registry-/proxyhinder i exekveringsmiljön.

### `npm run typecheck`

Exit status: `2`

```text
TS2688: Cannot find type definition file for 'vitest/globals'.
```

Orsak: beroendeinstallationen slutfördes inte.

### `npm run lint`

Exit status: `127`

```text
eslint: not found
```

### `npm test`

Exit status: `127`

```text
vitest: not found
```

### `npm run build`

Exit status: `1`

Prebuild försökte hämta `tsx` via den interna proxyn och fick `404 Not Found`.

### `npm run db:migrate:status`

Exit status: `1`

```text
Missing SUPABASE_DB_URL or DATABASE_URL in .env.local or shell.
```

### `VITEST_PG_REAL=1 npm run test:pg`

Exit status: `127`

```text
vitest: not found
```

Dessutom saknades en riktig PostgreSQL-URL.

### `node scripts/checks/migration-integrity.mjs --db`

Exit status: `1`

```text
Set SUPABASE_DB_URL or DATABASE_URL for --db.
```

## Slutsats

Patchen är statiskt härdad och har gröna guards, men den får inte betecknas som produktionsverifierad förrän beroenden kan installeras och hela typ-, lint-, unit-, build-, fresh-install-, upgrade-, RLS-, concurrency- och pg-real-matrisen är grön mot en riktig PostgreSQL-miljö.
