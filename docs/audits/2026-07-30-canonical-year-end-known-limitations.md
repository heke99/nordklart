# Kända begränsningar

> **Status: historical delivery record, archived 2026-07-30.**
>
> Open items as of 2026-07-30. **All three have since been closed**: the migration chain replays clean and is deployed and fingerprinted against production, `npm run test:pg` runs as a suite, and the two duplicate migration versions are reconciled and recorded in the manifest guard's known-collision set.
>
> It lived in the repository root until 2026-08-21, where it read as current
> guidance. Moving it here is the fix for that, not a re-endorsement.

- Den nya migrationen är parserkontrollerad men måste fortfarande appliceras
  och verifieras mot projektets riktiga stagingdatabas.
- Kör `npm run test:pg` efter migration och smoke-testa samtidig execute,
  stale preview och full rollback innan produktionsaktivering.
- Baslinjens två befintliga dubbla migrationsversioner måste stämmas av mot
  faktisk migrationshistorik före en generell migration av hela katalogen.
