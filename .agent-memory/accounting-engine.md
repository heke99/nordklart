# Bokföringsmotor

Kanonisk motor finns i `lib/bookkeeping/engine.ts` tillsammans med databasens
commit-RPC.

Invarianter:

- Debet och kredit balanserar exakt i heltalsöre.
- `roundOre()` eller domänens explicita öresfunktion används vid gränser.
- Låsta/stängda perioder kan inte muteras via alternativ väg.
- Konton, moms, verifikationsserie och datum valideras före commit.
- Korrigeringar är spårbara; historik skrivs inte tyst över.

Guard-baslinjen hittar 653 naiva avrundningsmönster. De ska klassificeras och
ersättas domänvis, med ekonomiska beräkningar först.

