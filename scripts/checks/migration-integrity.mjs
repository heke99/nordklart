#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATION_DIR = path.join(ROOT, 'supabase', 'migrations')
const MANIFEST_PATH = path.join(MIGRATION_DIR, 'manifest.sha256.json')
const ORDER_PATH = path.join(ROOT, 'MIGRATION_ORDER.md')
const FILE_RE = /^(\d{14})_(.+)\.sql$/

// These collisions pre-date the guard. They are not treated as healthy: the
// generated report marks them as reconciliation-required and no changed or new
// collision set is accepted.
const LEGACY_COLLISIONS = new Map([
  ['20260629120000', [
    '20260629120000_accounting_intelligence_core.sql',
    '20260629120000_opendataloader_ocr_foundation_and_founder_access.sql',
  ]],
  ['20260704120000', [
    '20260704120000_nordklart_sync_hardening_patch.sql',
    '20260704120000_skatteverket_sysorg_api_contract.sql',
  ]],
])

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * Every consumer of the migration chain globs `supabase/migrations/*.sql`: the
 * runner, this manifest, and the pg-real bootstrap. A .sql file in a
 * subdirectory is therefore silently never applied, while still being tracked
 * by git and looking like it shipped.
 *
 * That is not hypothetical — 20260731163000_year_end_pgcrypto_search_path_repair.sql
 * sat in supabase/migrations/supabase/migrations/ and no environment built from
 * the repository ever ran it, reintroducing the pgcrypto `digest` incident.
 */
function assertNoNestedMigrations() {
  const orphans = []
  const walk = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      const rel = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.name.endsWith('.sql') && relative) orphans.push(rel)
    }
  }
  walk(MIGRATION_DIR, '')
  if (orphans.length) {
    throw new Error(
      `Migration file(s) in a subdirectory of supabase/migrations/ will never be applied:\n`
      + orphans.map((file) => `  - ${file}`).join('\n')
      + '\nMove them to the top level of supabase/migrations/.',
    )
  }
}

function readMigrations() {
  assertNoNestedMigrations()
  return fs.readdirSync(MIGRATION_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((file, index) => {
      const match = FILE_RE.exec(file)
      if (!match) throw new Error(`Invalid migration filename: ${file}`)
      const sql = fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8')
      return { order: index + 1, file, version: match[1], name: match[2], sha256: sha256(sql) }
    })
}

function collisionMap(migrations) {
  const grouped = new Map()
  for (const migration of migrations) {
    const files = grouped.get(migration.version) ?? []
    files.push(migration.file)
    grouped.set(migration.version, files)
  }
  return new Map([...grouped].filter(([, files]) => files.length > 1))
}

function assertCollisionContract(migrations) {
  const actual = collisionMap(migrations)
  const failures = []
  for (const [version, files] of actual) {
    const allowed = LEGACY_COLLISIONS.get(version)
    if (!allowed || JSON.stringify([...files].sort()) !== JSON.stringify([...allowed].sort())) {
      failures.push(`${version}: ${files.join(', ')}`)
    }
  }
  for (const version of LEGACY_COLLISIONS.keys()) {
    if (!actual.has(version)) {
      // A forward reconciliation may eventually remove the file collision. That
      // is progress, not a failure; the manifest diff still makes it explicit.
      continue
    }
  }
  if (failures.length) {
    throw new Error(`New or changed duplicate migration version(s):\n${failures.map((x) => `- ${x}`).join('\n')}`)
  }
  return actual
}

function manifestFor(migrations) {
  return {
    format: 1,
    algorithm: 'sha256',
    files: migrations.map(({ file, version, sha256: hash }) => ({ file, version, sha256: hash })),
  }
}

function writeOrder(migrations, collisions) {
  const lines = [
    '# Migrationsordning',
    '',
    '> Genererad av `node scripts/checks/migration-integrity.mjs --write`.',
    '> Ändra inte filen manuellt.',
    '',
    `Antal SQL-migreringar: **${migrations.length}**.`,
    '',
    '## Kända versionskollisioner som måste reconcileras framåtriktat',
    '',
  ]
  if (collisions.size === 0) lines.push('Inga.')
  for (const [version, files] of collisions) {
    lines.push(`- \`${version}\`: ${files.map((f) => `\`${f}\``).join(', ')}`)
  }
  lines.push(
    '',
    'Kollisionerna får inte lösas genom att blint döpa om en redan applicerad fil. Kör först miljöjämförelsen nedan och skapa därefter unika, framåtriktade reconciliation-migreringar.',
    '',
    '## Verifiering mot databas',
    '',
    '```bash',
    'DATABASE_URL="postgresql://..." node scripts/checks/migration-integrity.mjs --db',
    '```',
    '',
    'Verktyget jämför både `supabase_migrations.schema_migrations` och Nordklarts checksummelog (`public.nordklart_schema_migrations`) när tabellerna finns.',
    '',
    '## Full ordning och SHA-256',
    '',
    '| # | Version | Fil | SHA-256 |',
    '|---:|---:|---|---|',
  )
  for (const migration of migrations) {
    lines.push(`| ${migration.order} | ${migration.version} | \`${migration.file}\` | \`${migration.sha256}\` |`)
  }
  fs.writeFileSync(ORDER_PATH, `${lines.join('\n')}\n`)
}

function compareManifest(migrations) {
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Missing manifest: ${path.relative(ROOT, MANIFEST_PATH)}`)
  const expected = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  const current = manifestFor(migrations)
  const expectedByFile = new Map(expected.files.map((entry) => [entry.file, entry]))
  const currentByFile = new Map(current.files.map((entry) => [entry.file, entry]))
  const errors = []
  for (const [file, entry] of currentByFile) {
    const old = expectedByFile.get(file)
    if (!old) errors.push(`Unmanifested migration: ${file}`)
    else if (old.version !== entry.version || old.sha256 !== entry.sha256) errors.push(`Checksum/version mismatch: ${file}`)
  }
  for (const file of expectedByFile.keys()) {
    if (!currentByFile.has(file)) errors.push(`Manifested migration is missing: ${file}`)
  }
  if (errors.length) throw new Error(errors.join('\n'))
}

async function compareDatabase(migrations) {
  const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!connectionString) throw new Error('Set SUPABASE_DB_URL or DATABASE_URL for --db.')
  let Client
  try {
    ;({ Client } = await import('pg'))
  } catch {
    throw new Error('The pg package is unavailable. Run npm ci before --db.')
  }
  const client = new Client({
    connectionString,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    application_name: 'nordklart-migration-integrity',
  })
  await client.connect()
  try {
    const localByFile = new Map(migrations.map((m) => [m.file, m]))
    const localVersions = new Set(migrations.map((m) => m.version))
    // Supabase-CLI history is optional: Nordklart production is migrated by
    // scripts/supabase-migrate.cjs, which writes public.nordklart_schema_migrations
    // instead. Its absence is expected there and is not drift by itself.
    const supabaseTable = await client.query("select to_regclass('supabase_migrations.schema_migrations')::text as name")
    if (supabaseTable.rows[0]?.name) {
      const rows = await client.query('select version::text from supabase_migrations.schema_migrations order by version')
      const dbVersions = new Set(rows.rows.map((row) => String(row.version)))
      const unknown = [...dbVersions].filter((version) => !localVersions.has(version))
      const absent = [...localVersions].filter((version) => !dbVersions.has(version))
      console.log(`supabase_migrations.schema_migrations: ${dbVersions.size} version(s)`) 
      if (unknown.length) console.error(`Versions only in DB: ${unknown.join(', ')}`)
      if (absent.length) console.error(`Versions not applied in DB: ${absent.join(', ')}`)
      for (const [version, files] of collisionMap(migrations)) {
        if (dbVersions.has(version)) {
          console.warn(`AMBIGUOUS ${version}: DB history cannot prove which of ${files.join(', ')} was applied.`)
        }
      }
      if (unknown.length || absent.length) process.exitCode = 1
    } else {
      console.warn('supabase_migrations.schema_migrations does not exist in this environment.')
    }

    const runnerTable = await client.query("select to_regclass('public.nordklart_schema_migrations')::text as name")
    if (runnerTable.rows[0]?.name) {
      const rows = await client.query('select version, checksum from public.nordklart_schema_migrations order by version')
      const seen = new Set()
      const errors = []
      for (const row of rows.rows) {
        const migration = localByFile.get(row.version)
        seen.add(row.version)
        if (!migration) errors.push(`Runner DB has unknown file: ${row.version}`)
        else if (migration.sha256 !== row.checksum) errors.push(`Runner checksum mismatch: ${row.version}`)
      }
      console.log(`public.nordklart_schema_migrations: ${rows.rowCount} file(s)`)

      // Repository files with no registry row. This direction was previously
      // computed (`seen`) but never compared, so a production database whose
      // ledger had fallen behind the repository reported clean. That is how a
      // 68-file gap stayed invisible: the schema objects existed because the
      // SQL had been applied out-of-band, but nothing recorded that it had.
      const unrecorded = migrations.map((m) => m.file).filter((file) => !seen.has(file))
      if (unrecorded.length) {
        console.error(
          `\n${unrecorded.length} migration file(s) have no row in public.nordklart_schema_migrations.`,
        )
        console.error('The schema objects may still exist if the SQL was applied out-of-band,')
        console.error('but the ledger cannot prove what this database actually has:')
        for (const file of unrecorded) console.error(`  - ${file}`)
        console.error(
          '\nReconcile with: npm run db:migrate:mark-through -- <lastAppliedFile>'
          + '\nthen apply the remainder with: npm run db:migrate\n',
        )
        errors.push(`${unrecorded.length} repository migration(s) missing from the runner registry`)
      }

      if (errors.length) {
        errors.forEach((error) => console.error(error))
        process.exitCode = 1
      }
    } else {
      console.warn('public.nordklart_schema_migrations does not exist in this environment.')
    }
  } finally {
    await client.end()
  }
}

async function main() {
  const migrations = readMigrations()
  const collisions = assertCollisionContract(migrations)
  if (!migrations.some((migration) => migration.file === '20260731171000_annual_report_finalization_and_controlled_reopen.sql')) {
    throw new Error('Latest annual-report finalization migration is missing from the chain.')
  }

  if (process.argv.includes('--write')) {
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifestFor(migrations), null, 2)}\n`)
    writeOrder(migrations, collisions)
    console.log(`Wrote ${path.relative(ROOT, MANIFEST_PATH)} and ${path.relative(ROOT, ORDER_PATH)} (${migrations.length} migrations).`)
  } else {
    compareManifest(migrations)
    console.log(`Migration manifest OK: ${migrations.length} files, ${collisions.size} known reconciliation-required collision set(s).`)
  }

  if (process.argv.includes('--db')) await compareDatabase(migrations)
}

main().catch((error) => {
  console.error(`migration-integrity: ${error.message}`)
  process.exit(1)
})
