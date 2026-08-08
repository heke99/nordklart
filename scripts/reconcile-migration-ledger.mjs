#!/usr/bin/env node
/**
 * Reconcile the migration ledger with what the database actually contains.
 *
 * `public.nordklart_schema_migrations` is the only migration authority this
 * project has, and production's ledger had fallen 68 files behind the
 * repository: the SQL had been applied out-of-band, so the schema objects
 * existed while nothing recorded that they did. `check:migrations --db` can see
 * that a row is missing, but it cannot tell "applied, just never recorded" from
 * "genuinely not applied" — and those two need opposite fixes. Recording an
 * unapplied migration hides real drift; re-running an applied one can fail or,
 * worse, succeed destructively.
 *
 * This tool answers that question per file by looking for the objects each
 * migration creates:
 *
 *   RECORDED               row present, checksum matches — nothing to do
 *   CHECKSUM_MISMATCH      row present, file has changed since it was applied
 *   APPLIED_BUT_UNRECORDED no row, but every object the file creates exists
 *   SUPERSEDED             no row, objects missing — but a LATER migration drops
 *                          or renames them, so absence is not evidence of anything
 *   NOT_APPLIED            no row, and none of its objects exist
 *   AMBIGUOUS              no row, and the evidence is partial or absent
 *
 * Only APPLIED_BUT_UNRECORDED is safe to fix by writing a ledger row, and only
 * that class is written — with --apply, which is never the default. NOT_APPLIED
 * belongs to `npm run db:migrate`. AMBIGUOUS needs a human: it covers files that
 * create nothing detectable (pure DML, GRANT-only, NOTIFY-only) and files whose
 * objects are only partly present, which is what an interrupted manual run looks
 * like.
 *
 * SUPERSEDED exists because object existence is a statement about the END of the
 * chain, not about one file. A migration that created get_unlinked_1930_lines was
 * certainly applied even though the function is gone — a later migration renamed
 * it. Reporting that as NOT_APPLIED would invite an operator to re-run history.
 * It is called out separately and never written, because "was it applied?" is not
 * decidable from the schema once a later file has erased the evidence.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/reconcile-migration-ledger.mjs [--apply] [--verbose]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATION_DIR = path.join(ROOT, 'supabase', 'migrations')
const LEDGER = 'public.nordklart_schema_migrations'

const APPLY = process.argv.includes('--apply')
const VERBOSE = process.argv.includes('--verbose')

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function readMigrations() {
  return fs.readdirSync(MIGRATION_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const sql = fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8')
      return { file, sql, checksum: sha256(sql) }
    })
}

/**
 * Strip comments and string literals before scanning for CREATE statements, so
 * a function body that documents `CREATE TABLE foo` in a comment (or embeds DDL
 * in a dollar-quoted string) is not mistaken for a real object this migration
 * creates. Over-detecting is the dangerous direction: it turns NOT_APPLIED into
 * APPLIED_BUT_UNRECORDED and invites a false ledger row.
 */
function stripNoise(sql) {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[A-Za-z_]\w*\$[\s\S]*?\$[A-Za-z_]\w*\$/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_]\w*)`
const QUALIFIED = String.raw`(?:(${IDENT})\s*\.\s*)?(${IDENT})`

function unquote(value) {
  if (!value) return null
  return value.startsWith('"') ? value.slice(1, -1) : value.toLowerCase()
}

/**
 * Objects a migration creates, as catalog probes. Only object kinds whose
 * existence is unambiguous are collected — DROP/ALTER-only migrations
 * deliberately yield nothing and land in AMBIGUOUS rather than guessing.
 */
function extractObjects(sql) {
  const cleaned = stripNoise(sql)
  const objects = []
  const add = (kind, schema, name, extra) => {
    if (!name) return
    objects.push({ kind, schema: unquote(schema) ?? 'public', name: unquote(name), extra })
  }

  const patterns = [
    [new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}`, 'gi'), 'table'],
    [new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}`, 'gi'), 'view'],
    [new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${QUALIFIED}`, 'gi'), 'function'],
    [new RegExp(String.raw`CREATE\s+TYPE\s+${QUALIFIED}`, 'gi'), 'type'],
  ]
  for (const [pattern, kind] of patterns) {
    for (const match of cleaned.matchAll(pattern)) add(kind, match[1], match[2])
  }

  // Indexes and policies are not schema-qualified in the same position, and
  // both are common in migrations that create nothing else.
  for (const match of cleaned.matchAll(
    new RegExp(
      String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+ON\s+${QUALIFIED}`,
      'gi',
    ),
  )) {
    // `owner` is the table the index hangs off. A dropped table takes its
    // indexes with it, and that association is the only way to tell "this
    // index was never created" from "its table is gone".
    objects.push({
      kind: 'index',
      schema: unquote(match[2]) ?? 'public',
      name: unquote(match[1]),
      owner: unquote(match[3]),
    })
  }

  for (const match of cleaned.matchAll(
    new RegExp(String.raw`CREATE\s+POLICY\s+("[^"]+"|'[^']*'|[A-Za-z_]\w*)\s+ON\s+${QUALIFIED}`, 'gi'),
  )) add('policy', match[2], match[3], unquote(match[1]))

  // ALTER TABLE ... ADD COLUMN is how most later migrations extend the schema.
  // Matched per statement, not across the whole file: a single ALTER can add
  // several columns, and a pattern that spans `;` happily binds one statement's
  // table to the next statement's column and then reports a phantom absence.
  for (const statement of cleaned.split(';')) {
    const target = new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${QUALIFIED}`, 'i').exec(statement)
    if (!target) continue
    for (const match of statement.matchAll(
      new RegExp(String.raw`ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`, 'gi'),
    )) add('column', target[1], target[2], unquote(match[1]))
  }

  const seen = new Set()
  return objects.filter((object) => {
    const key = `${object.kind}:${object.schema}:${object.name}:${object.extra ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const PROBES = {
  table: `SELECT to_regclass(quote_ident($1::text) || '.' || quote_ident($2::text)) IS NOT NULL AS present`,
  view: `SELECT to_regclass(quote_ident($1::text) || '.' || quote_ident($2::text)) IS NOT NULL AS present`,
  type: `SELECT to_regtype(quote_ident($1::text) || '.' || quote_ident($2::text)) IS NOT NULL AS present`,
  function: `SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1::text AND p.proname = $2::text
  ) AS present`,
  index: `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = $1::text AND indexname = $2::text) AS present`,
  policy: `SELECT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = $1::text AND tablename = $2::text AND policyname = $3::text
  ) AS present`,
  column: `SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = $1::text AND table_name = $2::text AND column_name = $3::text
  ) AS present`,
}

async function probe(client, object) {
  const sql = PROBES[object.kind]
  if (!sql) return null
  const params = object.kind === 'policy' || object.kind === 'column'
    ? [object.schema, object.name, object.extra]
    : [object.schema, object.name]
  const { rows } = await client.query(sql, params)
  return rows[0]?.present === true
}

/** Object names any LATER migration drops, so their absence proves nothing. */
function droppedLater(migrations, index) {
  const names = new Set()
  for (let i = index + 1; i < migrations.length; i += 1) {
    const cleaned = stripNoise(migrations[i].sql)
    for (const match of cleaned.matchAll(
      new RegExp(String.raw`DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|TYPE|INDEX|POLICY)\s+(?:IF\s+EXISTS\s+)?(?:${IDENT}\s*\.\s*)?(${IDENT})`, 'gi'),
    )) names.add(unquote(match[1]))
    for (const match of cleaned.matchAll(
      new RegExp(String.raw`DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(${IDENT})`, 'gi'),
    )) names.add(unquote(match[1]))
    for (const match of cleaned.matchAll(
      new RegExp(String.raw`RENAME\s+(?:COLUMN\s+)?(${IDENT})\s+TO`, 'gi'),
    )) names.add(unquote(match[1]))
  }
  return names
}

async function classify(client, migration, ledger, dropped) {
  const recorded = ledger.get(migration.file)
  if (recorded !== undefined) {
    return recorded === migration.checksum
      ? { status: 'RECORDED' }
      : { status: 'CHECKSUM_MISMATCH', note: 'file changed after it was applied' }
  }

  const objects = extractObjects(migration.sql)
  if (objects.length === 0) {
    return { status: 'AMBIGUOUS', note: 'creates no detectable object (DML/GRANT/NOTIFY only)' }
  }

  const absent = []
  for (const object of objects) {
    if (await probe(client, object) !== true) absent.push(object)
  }
  const present = objects.length - absent.length
  const missing = absent.map(
    (object) => `${object.kind} ${object.schema}.${object.name}${object.extra ? `.${object.extra}` : ''}`,
  )

  if (present === objects.length) {
    return { status: 'APPLIED_BUT_UNRECORDED', note: `all ${objects.length} object(s) present` }
  }

  // Absence only means "not applied" if nothing later removed the evidence.
  // A dropped table takes its columns, policies and indexes with it, so those
  // are explained by the owning relation's name rather than their own.
  const explained = (object) => {
    if (object.kind === 'column' || object.kind === 'policy') {
      return dropped.has(object.extra) || dropped.has(object.name)
    }
    if (object.kind === 'index') return dropped.has(object.name) || dropped.has(object.owner)
    return dropped.has(object.name)
  }
  if (absent.every(explained)) {
    return {
      status: 'SUPERSEDED',
      note: `${present}/${objects.length} present; the rest are dropped or renamed by a later migration`,
      missing,
    }
  }

  if (present === 0) {
    return { status: 'NOT_APPLIED', note: `none of ${objects.length} object(s) present` }
  }
  return {
    status: 'AMBIGUOUS',
    note: `${present}/${objects.length} object(s) present — looks like an interrupted run`,
    missing,
  }
}

async function main() {
  const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!connectionString) {
    console.error('Set SUPABASE_DB_URL or DATABASE_URL.')
    process.exit(1)
  }
  const { Client } = await import('pg')
  const client = new Client({
    connectionString,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    application_name: 'nordklart-ledger-reconcile',
  })
  await client.connect()

  try {
    const ledgerExists = await client.query(`SELECT to_regclass('${LEDGER}')::text AS name`)
    if (!ledgerExists.rows[0]?.name) {
      console.error(`${LEDGER} does not exist in this database. Run npm run db:migrate first.`)
      process.exit(1)
    }
    const { rows } = await client.query(`SELECT version, checksum FROM ${LEDGER}`)
    const ledger = new Map(rows.map((row) => [row.version, row.checksum]))

    const migrations = readMigrations()
    const byStatus = new Map()
    const results = []
    for (const [index, migration] of migrations.entries()) {
      const result = await classify(client, migration, ledger, droppedLater(migrations, index))
      results.push({ ...migration, ...result })
      byStatus.set(result.status, (byStatus.get(result.status) ?? 0) + 1)
    }

    const orphans = [...ledger.keys()].filter(
      (version) => !migrations.some((migration) => migration.file === version),
    )

    console.log(`Repository: ${migrations.length} migration(s)`)
    console.log(`${LEDGER}: ${ledger.size} row(s)\n`)
    for (const status of ['RECORDED', 'APPLIED_BUT_UNRECORDED', 'SUPERSEDED', 'NOT_APPLIED', 'CHECKSUM_MISMATCH', 'AMBIGUOUS']) {
      console.log(`  ${status.padEnd(22)} ${byStatus.get(status) ?? 0}`)
    }
    if (orphans.length) console.log(`  ${'LEDGER_ONLY'.padEnd(22)} ${orphans.length}`)
    console.log('')

    for (const result of results) {
      if (result.status === 'RECORDED' && !VERBOSE) continue
      console.log(`${result.status.padEnd(22)} ${result.file}${result.note ? `  — ${result.note}` : ''}`)
      if (VERBOSE && result.missing) {
        for (const item of result.missing) console.log(`${' '.repeat(24)}missing: ${item}`)
      }
    }
    for (const version of orphans) console.log(`${'LEDGER_ONLY'.padEnd(22)} ${version}  — row has no file in the repository`)

    const writable = results.filter((result) => result.status === 'APPLIED_BUT_UNRECORDED')
    if (!APPLY) {
      console.log(`\nDry run. ${writable.length} file(s) could be recorded with --apply.`)
      console.log('NOT_APPLIED belongs to `npm run db:migrate`; SUPERSEDED, AMBIGUOUS and')
      console.log('CHECKSUM_MISMATCH need a human — none of them are written by --apply.')
      return
    }
    if (writable.length === 0) {
      console.log('\nNothing to record.')
      return
    }

    await client.query('BEGIN')
    try {
      for (const migration of writable) {
        await client.query(
          `INSERT INTO ${LEDGER} (version, checksum, source) VALUES ($1, $2, 'reconciled')
           ON CONFLICT (version) DO NOTHING`,
          [migration.file, migration.checksum],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    console.log(`\nRecorded ${writable.length} file(s) as source='reconciled'.`)
    console.log('Re-run `npm run check:migrations:db` to confirm the ledger now describes the database.')
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(`reconcile-migration-ledger: ${error.message}`)
  process.exit(1)
})
