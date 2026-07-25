# Kanonisk arkitektur

| Ansvar | Kanonisk ägare |
|---|---|
| Inloggning och MFA | `lib/api/require-auth.ts` och route wrappers |
| Företagsmedlemskap och roll | server-side membership/RBAC helpers samt RLS |
| Kommersiell åtkomst | SQL-funktionerna `resolve_company_access*` |
| Featureåtkomst | SQL `company_feature_access` och `lib/platform/entitlements.ts` |
| Routepolicy | `lib/platform/feature-policy.ts` och API wrappers |
| Verifikationsmotor | `lib/bookkeeping/engine.ts` och commit-RPC |
| Bokslutsåtkomst | `lib/year-end/access.ts` |
| Bokslutskörning | `execute_year_end_closing` och `year_end_db_blockers` |
| SIE-import | dedikerad resolver/finalisering i importdomänen |
| Rapporter | domänspecifika kanoniska rapportgeneratorer |

Ny funktionalitet ska anropa dessa ägare i stället för att duplicera logik i
sidor, routes eller komponenter.

