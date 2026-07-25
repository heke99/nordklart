# Aktuellt läge

Datum: 2026-07-25.

Implementerat i aktuellt arbetspass:

- Systemisk separation mellan verkligt featureavslag och tekniskt databasfel.
- Samma felklassning genom dashboard, routepolicy, API v1 och bokslutsroutes.
- Periodbundet bokslutsköp fortsätter ge åtkomst vid feature-resolveravbrott.
- Billing, Bankgiro, Bankautomation och Bokslut använder kanonisk åtkomst.
- Next 16-signaturer i SIE-mappingtester korrigerade.
- README, projektregler och beständigt agentminne uppdaterade.

Verifierat i aktuell källkod:

- TypeScript: 0 fel.
- Vitest unit-projekt: 484 filer passerar, 1 skip; 6 096 tester passerar,
  2 skip.
- ESLint: 0 fel, 228 befintliga varningar.
- Lintbaseline: 0 nya fel.
- Antipattern-guard: passerar med ratchetad baslinje 167 rå-auth-routes,
  653 avrundningsträffar och 2 migration/RLS-träffar.
- Featurepolicy: 459 routefiler och 289 operationer täckta.
- Skill bodies: 108 atomer synkade; FAQ-data oförändrad och synkad.
- Produktionsbygge: passerade efter den systemiska kodändringen med 353
  genererade sidor. Den efterföljande preciseringen av Bokslutssidans
  giltighetsfönster passerar TypeScript och riktad ESLint. En andra byggkörning
  stoppades före start av körmiljöns användningsgräns.

Live-DB, pg-real och RLS-verifiering är fortfarande extern enligt
`open-blockers.md`.
