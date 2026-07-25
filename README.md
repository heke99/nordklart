# Nordklart

Nordklart är ett svenskt ekonomi-, bokförings- och bokslutssystem för företag,
redovisningsbyråer och externa integrationspartners. Plattformen bygger på
Next.js 16, React 19, TypeScript och Supabase/PostgreSQL.

Systemets centrala principer är:

- dubbel bokföring med atomisk postning och databasvaliderad balans;
- oföränderliga bokförda verifikationer med spårbara storno- och rättelsekedjor;
- tenantisolering genom server-side företagskontext, RLS och explicita behörigheter;
- en canonical feature-resolver för planer, tillägg, Full Access och engångsköp;
- reproducerbara SIE-, bank- och dokumentimporter;
- atomiskt bokslut med readiness, advisory lock, idempotens och audit;
- rapporter och årsredovisningsunderlag härledda från samma huvudbok.

## Kom igång

Krav: Node.js 22 och npm.

```bash
npm ci
npm run dev
```

Skapa lokala miljövariabler enligt projektets deploymentdokumentation. Lägg
aldrig hemligheter i repositoryt.

## Verifiering

```bash
NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck
npm run lint
npm run check:lint
npm test
npm run check:guards
npm run check:feature-policy
npm run build
```

Databas- och RLS-sviten kräver en riktig PostgreSQL-instans:

```bash
npm run test:pg:bootstrap
npm run test:pg
npm run db:migrate:status
```

## Arkitektur

- `app/` – App Router, dashboard och API-routes.
- `lib/bookkeeping/` – canonical bokföringsmotor.
- `lib/core/bookkeeping/` – postning, storno, perioder och bokslut.
- `lib/platform/` – feature-, plan- och entitlementresolution.
- `lib/import/` – SIE-, bank- och registerimport.
- `lib/reports/` och `lib/bokslut/` – rapporter, årsredovisning och iXBRL.
- `supabase/migrations/` – append-only databasmigrationer.
- `tests/pg/` – verkliga PostgreSQL-, RLS- och concurrencytester.
- `.agent-memory/` – verifierad, Git-versionerad projektstatus.

Detaljerade arbetsregler finns i `AGENTS.md`, `CLAUDE.md`,
`.cursor/rules/` och `.claude/rules/`.

## Licens

Proprietary. Se `LICENSE` och `NOTICE`.
