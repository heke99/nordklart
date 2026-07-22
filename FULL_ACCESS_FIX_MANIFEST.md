# Nordklart – Full Access authoritative fix

This patch is based on `nordklart-main(12).zip`.

Apply both migrations in timestamp order:

1. `20260722224500_complimentary_access_grant_backfill.sql`
2. `20260722233000_full_access_authoritative_resolver.sql`

The first migration repairs and maintains grant snapshots. The second makes the active Full Access grant authoritative at access-resolution time, so access no longer depends on a paid subscription or a complete snapshot.
