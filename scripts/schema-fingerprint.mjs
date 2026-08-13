#!/usr/bin/env node
/**
 * Emit the SQL that fingerprints a database's `public` schema by CONTENT.
 *
 * `reconcile-migration-ledger.mjs` decides whether a migration ran by asking
 * whether the objects it names exist. That is sound for a migration that
 * CREATEs something new and unsound for every migration that REPLACES
 * something: `CREATE OR REPLACE FUNCTION`, `DROP POLICY` + `CREATE POLICY`
 * under the same name, `ALTER FUNCTION ... SET search_path`, a re-granted ACL,
 * a rebuilt CHECK constraint. The object exists either way, so existence
 * cannot distinguish "applied" from "never ran". Marking a replacing migration
 * applied on that evidence is exactly how a security fix gets recorded as
 * deployed while production stays exploitable.
 *
 * What settles it is the definition itself. A clean replay of the repository's
 * migration chain into an empty database IS the canonical target state, so the
 * question "did production receive this migration" becomes the much stronger
 * "does production's definition of every object it touches equal the canonical
 * one". That also answers repo↔production drift in the same pass.
 *
 * Two modes, because a full fingerprint is thousands of rows and the deploy
 * environment reaches production through a request parameter:
 *
 *   node scripts/schema-fingerprint.mjs summary
 *      One row per object kind: count plus an order-independent aggregate hash.
 *      Equal on both sides = no drift in that kind, settled in one round trip.
 *
 *   node scripts/schema-fingerprint.mjs detail --kind function [--like pattern]
 *      One row per object, for drilling into whichever kind disagreed.
 *
 * Definitions are whitespace-normalised before hashing. PostgreSQL pretty-prints
 * `pg_get_functiondef` and friends, and the local replay (16) and production
 * (17) do not always agree on spacing for identical source. Collapsing runs of
 * whitespace removes that difference without hiding a real one — any change to
 * an identifier, a predicate, a grant or a setting still changes the hash.
 */
import process from 'node:process'

/**
 * One SELECT per object kind, each yielding (kind, identity, definition).
 * Identity must be stable across databases, so it never contains an OID.
 */
const SOURCES = {
  // Bodies, volatility, SECURITY DEFINER, and the pinned search_path all live
  // in the definition; proconfig is appended so an unpinned function can never
  // hash the same as a pinned one.
  function: `
    SELECT 'function' AS kind,
           n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS identity,
           pg_get_functiondef(p.oid)
             || ' ||proconfig=' || coalesce(array_to_string(p.proconfig, ','), '')
             || ' ||secdef=' || p.prosecdef::text AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')`,

  // reloptions carries security_invoker/security_barrier — the whole point of
  // the cross-tenant view fix, and invisible in the view body.
  view: `
    SELECT 'view' AS kind,
           n.nspname || '.' || c.relname AS identity,
           pg_get_viewdef(c.oid, true)
             || ' ||reloptions=' || coalesce(array_to_string(c.reloptions, ','), '') AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')`,

  policy: `
    SELECT 'policy' AS kind,
           schemaname || '.' || tablename || '.' || policyname AS identity,
           cmd || ' permissive=' || permissive
             || ' roles=' || array_to_string(roles, ',')
             || ' using=' || coalesce(qual, '')
             || ' check=' || coalesce(with_check, '') AS definition
    FROM pg_policies WHERE schemaname = 'public'`,

  trigger: `
    SELECT 'trigger' AS kind,
           n.nspname || '.' || c.relname || '.' || t.tgname AS identity,
           pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal`,

  constraint: `
    SELECT 'constraint' AS kind,
           n.nspname || '.' || c.relname || '.' || con.conname AS identity,
           pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'`,

  index: `
    SELECT 'index' AS kind,
           schemaname || '.' || indexname AS identity,
           indexdef AS definition
    FROM pg_indexes WHERE schemaname = 'public'`,

  column: `
    SELECT 'column' AS kind,
           table_schema || '.' || table_name || '.' || column_name AS identity,
           data_type || ' null=' || is_nullable
             || ' default=' || coalesce(column_default, '')
             || ' len=' || coalesce(character_maximum_length::text, '')
             || ' prec=' || coalesce(numeric_precision::text, '')
             || ' scale=' || coalesce(numeric_scale::text, '') AS definition
    FROM information_schema.columns WHERE table_schema = 'public'`,

  // RLS being enabled is a security fact of its own, independent of policies.
  rls: `
    SELECT 'rls' AS kind,
           n.nspname || '.' || c.relname AS identity,
           'rls=' || c.relrowsecurity::text || ' forced=' || c.relforcerowsecurity::text AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`,

  // Who may reach each table and function through PostgREST. A REVOKE that
  // never landed is a hole, and nothing else in this list would show it.
  table_grant: `
    SELECT 'table_grant' AS kind,
           table_schema || '.' || table_name || '.' || grantee || '.' || privilege_type AS identity,
           'granted' AS definition
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')`,

  function_grant: `
    SELECT 'function_grant' AS kind,
           n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ').' || r.rolname AS identity,
           'execute' AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN (SELECT unnest(ARRAY['anon', 'authenticated', 'service_role']) AS rolname) r
    WHERE n.nspname = 'public' AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
}

/**
 * Objects this repository knowingly does not hold identical across databases.
 * The ledger is created by the runner rather than by a migration, so a clean
 * replay has no such table at all; the deploy staging table is transient.
 */
const EXCLUDED = ['nordklart_schema_migrations', 'nordklart_deploy_staging']

function excludeClause(column) {
  return EXCLUDED.map((name) => `${column} NOT LIKE '%${name}%'`).join(' AND ')
}

function unionAll() {
  return Object.values(SOURCES).map((sql) => `(${sql.trim()})`).join('\n    UNION ALL\n    ')
}

/**
 * Whitespace-normalised content hash. `md5` rather than sha256 only because it
 * is a bare built-in on every PostgreSQL — this detects drift, it does not
 * defend against a forger.
 */
const HASHED = `
  SELECT kind, identity,
         md5(regexp_replace(btrim(definition), '\\s+', ' ', 'g')) AS content_hash
  FROM (
    ${unionAll()}
  ) raw
  WHERE ${excludeClause('identity')}`

function summarySql() {
  // Order-independent: XOR-style aggregate over per-object hashes, expressed as
  // an md5 of the sorted concatenation so both databases compute it the same way.
  return `WITH fingerprint AS (${HASHED}
)
SELECT kind,
       count(*) AS objects,
       md5(string_agg(identity || '=' || content_hash, '|' ORDER BY identity)) AS kind_hash
FROM fingerprint
GROUP BY kind
ORDER BY kind;`
}

/**
 * Per-kind hashes split into 16 buckets by the first hex digit of md5(identity).
 *
 * A full fingerprint is thousands of rows and the deploy environment reaches
 * production through a request parameter, so pulling every row is not an
 * option. Bucketing localises a disagreement without needing to know what
 * disagreed: compare 16 short hashes per kind, then fetch rows only from the
 * buckets that differ. Hashing the identity (not the table name) keeps buckets
 * evenly filled whatever the schema looks like.
 */
function bucketSql(kind) {
  return `WITH fingerprint AS (${HASHED}
)
SELECT substr(md5(identity), 1, 1) AS bucket,
       count(*) AS objects,
       md5(string_agg(identity || '=' || content_hash, '|' ORDER BY identity)) AS bucket_hash
FROM fingerprint
WHERE kind = '${kind.replace(/'/g, "''")}'
GROUP BY 1
ORDER BY 1;`
}

function bucketDetailSql(kind, buckets) {
  const list = buckets.map((b) => `'${b.replace(/'/g, "''")}'`).join(', ')
  return `WITH fingerprint AS (${HASHED}
)
SELECT identity, content_hash
FROM fingerprint
WHERE kind = '${kind.replace(/'/g, "''")}' AND substr(md5(identity), 1, 1) IN (${list})
ORDER BY identity;`
}

function detailSql(kind, like) {
  const filter = like ? ` AND identity LIKE ${`'${like.replace(/'/g, "''")}'`}` : ''
  return `WITH fingerprint AS (${HASHED}
)
SELECT identity, content_hash
FROM fingerprint
WHERE kind = '${kind.replace(/'/g, "''")}'${filter}
ORDER BY identity;`
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const flag = (name) => {
    const i = rest.indexOf(name)
    return i === -1 ? null : rest[i + 1]
  }

  if (command === 'summary') {
    process.stdout.write(`${summarySql()}\n`)
    return
  }
  if (command === 'buckets') {
    const kind = flag('--kind')
    if (!kind || !(kind in SOURCES)) {
      throw new Error(`buckets needs --kind <${Object.keys(SOURCES).join('|')}>`)
    }
    process.stdout.write(`${bucketSql(kind)}\n`)
    return
  }
  if (command === 'bucket-detail') {
    const kind = flag('--kind')
    const buckets = (flag('--buckets') ?? '').split(',').map((b) => b.trim()).filter(Boolean)
    if (!kind || !(kind in SOURCES)) throw new Error('bucket-detail needs --kind')
    if (buckets.length === 0) throw new Error('bucket-detail needs --buckets <hex,hex,...>')
    process.stdout.write(`${bucketDetailSql(kind, buckets)}\n`)
    return
  }
  if (command === 'detail') {
    const kind = flag('--kind')
    if (!kind || !(kind in SOURCES)) {
      throw new Error(`detail needs --kind <${Object.keys(SOURCES).join('|')}>`)
    }
    process.stdout.write(`${detailSql(kind, flag('--like'))}\n`)
    return
  }
  throw new Error('Usage: schema-fingerprint.mjs summary | detail --kind <kind> [--like <pattern>]')
}

main()
