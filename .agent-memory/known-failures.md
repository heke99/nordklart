# Kända felmönster

- Rå `getUser()` i routes kan missa den kanoniska MFA-/RBAC-kedjan.
- Planbaserad UI-inferens kan avvika från grants och entitlements.
- Att mappa resolverfel till saknad entitlement skapar falska betalväggar.
- Oerhållen `Date.now()` under React-rendering bryter lint och reproducerbarhet.
- Otydliga SQL-kolumner som `open_amount` kan bli tvetydiga i PL/pgSQL.
- Naiv `Math.round(value * 100)` kan ge ekonomiska öresfel.
- `npx tsx` kan misslyckas med IPC `EPERM` i begränsade sandlådor; använd
  `node --import tsx <script>` för verifiering i den miljön.

