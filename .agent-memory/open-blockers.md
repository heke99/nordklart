# Aktiva blockerare och skuld

1. Den nya migrationen är PostgreSQL-parsad men kan inte exekveras mot
   målmiljön utan en databasanslutning.
2. pg-real-, RLS- och tenantisoleringstester kan inte köras utan en separat
   PostgreSQL-testdatabas.
3. 167 routefiler finns kvar i guard-baslinjen för rå auth.
4. 653 naiva avrundningsmönster finns kvar i guard-baslinjen.
5. Två befintliga statiska migration/RLS-träffar behöver livegranskning.

Punkt 3–5 är existerande skuld i mottagen baslinje och har inte dolts genom
ändrade guardundantag.
