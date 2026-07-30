# Kända begränsningar

- Den nya migrationen är parserkontrollerad men måste fortfarande appliceras
  och verifieras mot projektets riktiga stagingdatabas.
- Kör `npm run test:pg` efter migration och smoke-testa samtidig execute,
  stale preview och full rollback innan produktionsaktivering.
- Baslinjens två befintliga dubbla migrationsversioner måste stämmas av mot
  faktisk migrationshistorik före en generell migration av hela katalogen.
