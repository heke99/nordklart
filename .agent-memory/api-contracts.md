# API-kontrakt

- API-svar ska använda stabila statuskoder och strukturerade felkoder.
- Featureavslag och tekniska upplösningsfel är olika kontrakt:
  - verkligt avslag: `403`, uppgraderingsinformation kan visas;
  - provisioning pågår: `409`, ingen uppgraderingslänk;
  - resolver/databasfel: retrybart `503` eller strukturerat `INTERNAL_ERROR`,
    ingen uppgraderingslänk.
- Validering sker vid gränsen och auktorisering före domänmutation.
- Idempotens ska användas för import-, betalnings- och bokföringsoperationer där
  återförsök kan skapa dubbleringar.

