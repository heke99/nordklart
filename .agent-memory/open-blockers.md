# Aktiva blockerare och skuld

1. `SUPABASE_DB_URL`/`DATABASE_URL` saknas. De fyra nya migrationerna kan därför
   inte appliceras eller exekveras i detta arbetsutrymme.
2. pg-real/RLS-testfilen finns men försöket stoppades av
   `ECONNREFUSED 127.0.0.1:5432`; inga PostgreSQL-testresultat påstås.
3. Mottagen baslinje innehåller två dubbla migrationsversioner:
   `20260629120000` och `20260704120000`. De gamla migrationerna har inte
   namnändrats eftersom applicerade migrationsfiler är immutabla.
4. Betalning av migrerade AR/AP-poster har datamodell och dublettskydd men
   saknar ännu en samlad produktionsroute som både länkar och vid behov bokar
   betalningen atomiskt.
5. Historiska banktabeller och manuell verifiering finns, men import av ett
   äldre kontoutdrag till radnivå kräver fortsatt parser-/UI-arbete.
6. Bolagsverket-snapshot kan användas via befintlig registerintegration, men
   den nya bokslutsytan väljer i denna leverans profilfält och låser dem; ett
   fullständigt fält-för-fält merge-UI mot registerkällan återstår.
7. Produktionsbygget behöver nätåtkomst till Google Fonts. Själva bygget
   passerade med build-only mocks, men en omockad körning i sandlådan fick
   HTTP 502 från `fonts.gstatic.com`.

Punkt 1–3 och 7 är miljö-/baslinjeförhållanden. Punkt 4–6 är uttryckligt kvarvarande
produktarbete och ska inte betraktas som färdigverifierat.
