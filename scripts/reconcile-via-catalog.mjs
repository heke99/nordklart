#!/usr/bin/env node
/**
 * Run the ledger reconciliation against a database reachable only through the
 * Supabase management API.
 *
 * `reconcile-migration-ledger.mjs` needs a Postgres connection string. The
 * agent environment that performs the production deploy does not have one — it
 * can execute SQL through the management API but cannot open a socket. Rather
 * than grow a second implementation of the classification rules (which is
 * exactly the double-truth this repository keeps getting bitten by), this
 * script imports `classify`, `extractObjects` and `droppedLater` from the
 * canonical tool and gives them a client whose only job is to answer object
 * probes from a presence map fetched in bulk.
 *
 * Two steps, so the SQL round-trip is explicit and auditable:
 *
 *   node scripts/reconcile-via-catalog.mjs probes  > probes.sql
 *      Emits one query returning every object the unrecorded migrations claim
 *      to create, together with whether it exists. Run it against production.
 *
 *   node scripts/reconcile-via-catalog.mjs classify --ledger <json> --presence <json>
 *      Consumes that result and prints the same report the canonical tool does.
 *
 * The ledger is supplied as JSON rather than read from the database for the
 * same reason: `{ "<file>": "<checksum>", ... }`.
 */
import fs from 'node:fs'
import process from 'node:process'
import {
  readMigrations,
  extractObjects,
  droppedLater,
  classify,
} from './reconcile-migration-ledger.mjs'

const PROBE_SQL_BY_KIND = {
  table: 'table',
  view: 'view',
  type: 'type',
  function: 'function',
  index: 'index',
  policy: 'policy',
  column: 'column',
}

/** Stable key for one object, used on both sides of the round-trip. */
function keyOf(object) {
  return [
    object.kind,
    object.schema,
    object.name,
    object.extra ?? '',
  ].join('')
}

function quote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/** Every object claimed by a migration that has no ledger row. */
function objectsToProbe(migrations, ledger) {
  const seen = new Map()
  for (const migration of migrations) {
    if (ledger[migration.file] !== undefined) continue
    for (const object of extractObjects(migration.sql)) {
      seen.set(keyOf(object), object)
    }
  }
  return [...seen.values()]
}

function emitProbeSql(objects) {
  const values = objects
    .map((o) => `(${quote(o.kind)},${quote(o.schema)},${quote(o.name)},${quote(o.extra ?? '')},${quote(o.owner ?? '')})`)
    .join(',\n    ')

  // One query, one row per object, `present` decided by the same catalog
  // lookups the canonical tool's PROBES use.
  return `WITH probe(kind, schema_name, obj_name, extra, owner) AS (
  VALUES
    ${values}
)
SELECT kind, schema_name, obj_name, extra,
  CASE kind
    WHEN 'table'  THEN to_regclass(quote_ident(schema_name) || '.' || quote_ident(obj_name)) IS NOT NULL
    WHEN 'view'   THEN to_regclass(quote_ident(schema_name) || '.' || quote_ident(obj_name)) IS NOT NULL
    WHEN 'type'   THEN to_regtype(quote_ident(schema_name) || '.' || quote_ident(obj_name)) IS NOT NULL
    WHEN 'function' THEN EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = schema_name AND p.proname = obj_name)
    WHEN 'index'  THEN EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname = schema_name AND indexname = obj_name)
    WHEN 'policy' THEN EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = schema_name AND tablename = obj_name AND policyname = extra)
    WHEN 'column' THEN EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = schema_name AND table_name = obj_name AND column_name = extra)
  END AS present
FROM probe
ORDER BY kind, schema_name, obj_name, extra;`
}

/**
 * A client that satisfies exactly the queries `classify` issues, answering
 * from the presence map. Anything else is a programming error and throws
 * rather than silently returning "absent", which would fabricate NOT_APPLIED.
 */
function catalogClient(presence) {
  return {
    async query(sql, params) {
      const kind = Object.keys(PROBE_SQL_BY_KIND).find((k) => {
        if (k === 'table' || k === 'view') return sql.includes('to_regclass')
        if (k === 'type') return sql.includes('to_regtype')
        if (k === 'function') return sql.includes('pg_proc')
        if (k === 'index') return sql.includes('pg_indexes')
        if (k === 'policy') return sql.includes('pg_policies')
        if (k === 'column') return sql.includes('information_schema.columns')
        return false
      })
      if (!kind) throw new Error(`catalogClient: unexpected query\n${sql}`)

      // to_regclass answers both table and view; the presence map is keyed by
      // the kind the migration declared, so try both before giving up.
      const [schema, name, extra] = params
      const candidates = kind === 'table' ? ['table', 'view'] : [kind]
      for (const candidate of candidates) {
        const key = [candidate, schema, name, extra ?? ''].join('')
        if (key in presence) return { rows: [{ present: presence[key] }] }
      }
      throw new Error(
        `catalogClient: no probe result for ${kind} ${schema}.${name}${extra ? `.${extra}` : ''}. `
        + 'Re-run the probes step — the presence map is stale.',
      )
    },
  }
}

async function main() {
  const command = process.argv[2]
  const arg = (flag) => {
    const index = process.argv.indexOf(flag)
    return index === -1 ? null : process.argv[index + 1]
  }

  const migrations = readMigrations()

  if (command === 'probes') {
    const ledgerPath = arg('--ledger')
    if (!ledgerPath) throw new Error('probes needs --ledger <json>')
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
    const objects = objectsToProbe(migrations, ledger)
    process.stderr.write(
      `${objects.length} object(s) to probe across ${migrations.filter((m) => ledger[m.file] === undefined).length} unrecorded migration(s)\n`,
    )
    process.stdout.write(emitProbeSql(objects))
    return
  }

  if (command === 'classify') {
    const ledger = JSON.parse(fs.readFileSync(arg('--ledger'), 'utf8'))
    const probeRows = JSON.parse(fs.readFileSync(arg('--presence'), 'utf8'))
    const presence = {}
    for (const row of probeRows) {
      presence[[row.kind, row.schema_name, row.obj_name, row.extra ?? ''].join('')] = row.present === true
    }

    const client = catalogClient(presence)
    const ledgerMap = new Map(Object.entries(ledger))
    const byStatus = new Map()
    const results = []
    for (const [index, migration] of migrations.entries()) {
      const result = await classify(client, migration, ledgerMap, droppedLater(migrations, index))
      results.push({ ...migration, ...result })
      byStatus.set(result.status, (byStatus.get(result.status) ?? 0) + 1)
    }

    console.log(`Repository: ${migrations.length} migration(s)`)
    console.log(`Ledger:     ${ledgerMap.size} row(s)\n`)
    for (const status of [
      'RECORDED', 'APPLIED_BUT_UNRECORDED', 'SUPERSEDED',
      'NOT_APPLIED', 'CHECKSUM_MISMATCH', 'AMBIGUOUS',
    ]) {
      console.log(`  ${status.padEnd(22)} ${byStatus.get(status) ?? 0}`)
    }
    const orphans = [...ledgerMap.keys()].filter((v) => !migrations.some((m) => m.file === v))
    if (orphans.length) console.log(`  ${'LEDGER_ONLY'.padEnd(22)} ${orphans.length}`)
    console.log('')

    for (const result of results) {
      if (result.status === 'RECORDED') continue
      console.log(`${result.status.padEnd(22)} ${result.file}${result.note ? `  — ${result.note}` : ''}`)
      if (result.missing) for (const item of result.missing) console.log(`${' '.repeat(24)}missing: ${item}`)
    }
    return
  }

  throw new Error('Usage: reconcile-via-catalog.mjs probes|classify')
}

main().catch((error) => {
  console.error(`reconcile-via-catalog: ${error.message}`)
  process.exit(1)
})
