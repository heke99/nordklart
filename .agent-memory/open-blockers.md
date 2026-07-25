# Aktiva blockerare och skuld

1. Målmiljöns migrationer och RLS kan inte liveverifieras utan DB-anslutning.
2. 167 routefiler finns kvar i guard-baslinjen för rå auth; de innebär möjlig
   avvikelse från kanonisk MFA/RBAC.
3. 653 naiva avrundningsmönster finns i guard-baslinjen och behöver domänvis
   klassificering.
4. Två statiska migration/RLS-träffar finns i guard-baslinjen och behöver
   konkret databasgranskning.

Punkt 2–4 är existerande skuld i mottagen baslinje och får inte döljas genom att
öka eller nollställa guardundantag.

