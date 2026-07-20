#!/usr/bin/env node

const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
try {
  require("dotenv").config({ path: path.resolve(process.cwd(), ".env.local") })
  require("dotenv").config({ path: path.resolve(process.cwd(), ".env") })
} catch {
  // dotenv is optional at runtime; environment variables can also be provided by the shell.
}

const MIGRATION_TABLE = "nordklart_schema_migrations"
const DEFAULT_DIR = "supabase/migrations"
const LOCK_ID = 734001347

const USAGE = `
Nordklart Supabase migration runner

Usage:
  node scripts/supabase-migrate.cjs list [migrationDir]
  node scripts/supabase-migrate.cjs status [migrationDir]
  node scripts/supabase-migrate.cjs plan-after [migrationDir] <lastAppliedFile>
  node scripts/supabase-migrate.cjs mark-through [migrationDir] <lastAppliedFile>
  node scripts/supabase-migrate.cjs up [migrationDir]

Environment:
  SUPABASE_DB_URL or DATABASE_URL must be a Postgres connection string.

Recommended current flow after manual copy/paste through:
  20260324120001_skatteverket_tokens.sql

  npm run db:migrate:plan-after -- 20260324120001_skatteverket_tokens.sql
  npm run db:migrate:mark-through -- 20260324120001_skatteverket_tokens.sql
  npm run db:migrate
`.trim()

function fail(message) {
  console.error(`\n${message}\n`)
  process.exit(1)
}

function checksum(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex")
}

function normalizeFileName(value) {
  if (!value) return value
  return path.basename(String(value).trim())
}

function looksLikeSqlFile(value) {
  return typeof value === "string" && value.endsWith(".sql")
}

function parseArgs(argv) {
  const command = argv[2]
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE)
    process.exit(0)
  }

  const rest = argv.slice(3)
  let migrationDir = DEFAULT_DIR
  let fileArg

  if (rest.length > 0) {
    if (looksLikeSqlFile(rest[0])) {
      fileArg = rest[0]
    } else {
      migrationDir = rest[0]
      fileArg = rest[1]
    }
  }

  return {
    command,
    migrationDir: path.resolve(process.cwd(), migrationDir),
    fileArg: normalizeFileName(fileArg),
  }
}

function readMigrations(migrationDir) {
  if (!fs.existsSync(migrationDir)) {
    fail(`Migration directory does not exist: ${migrationDir}`)
  }

  const files = fs
    .readdirSync(migrationDir)
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))

  if (files.length === 0) {
    fail(`No .sql migrations found in: ${migrationDir}`)
  }

  return files.map((file, index) => {
    const absolutePath = path.join(migrationDir, file)
    const sql = fs.readFileSync(absolutePath, "utf8")
    return {
      index: index + 1,
      file,
      absolutePath,
      checksum: checksum(sql),
      sql,
      hasOwnTransaction:
        /^\s*begin\s*;/im.test(sql) || /^\s*commit\s*;/im.test(sql),
    }
  })
}

function findMigration(migrations, file) {
  const target = normalizeFileName(file)
  const migration = migrations.find((item) => item.file === target)
  if (!migration) {
    fail(`Could not find migration "${target}". Check the exact filename.`)
  }
  return migration
}

async function connect() {
  const connectionString = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL
  if (!connectionString) {
    fail("Missing SUPABASE_DB_URL or DATABASE_URL in .env.local or shell.")
  }

  let Client
  try {
    ;({ Client } = require("pg"))
  } catch {
    fail("Missing npm package pg. Run npm install first, or install it with npm install -D pg.")
  }

  const client = new Client({
    connectionString,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    application_name: "nordklart-migration-runner",
  })

  await client.connect()
  return client
}

async function ensureLogTable(client) {
  await client.query(`
    create table if not exists public.${MIGRATION_TABLE} (
      version text primary key,
      checksum text not null,
      source text not null default 'runner',
      applied_at timestamptz not null default now()
    );
  `)
}

async function readApplied(client) {
  await ensureLogTable(client)
  const result = await client.query(
    `select version, checksum from public.${MIGRATION_TABLE} order by version`,
  )
  return new Map(result.rows.map((row) => [row.version, row.checksum]))
}

async function withLock(client, fn) {
  const lock = await client.query("select pg_try_advisory_lock($1) as locked", [LOCK_ID])
  if (!lock.rows[0]?.locked) {
    fail("Another migration runner is already active. Stop it before running this.")
  }

  try {
    return await fn()
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {})
  }
}

async function runSqlMigration(client, migration) {
  const wrapped = !migration.hasOwnTransaction
  if (wrapped) {
    await client.query("begin")
  }

  try {
    await client.query(migration.sql)
    await client.query(
      `
      insert into public.${MIGRATION_TABLE} (version, checksum, source)
      values ($1, $2, 'runner')
      `,
      [migration.file, migration.checksum],
    )

    if (wrapped) {
      await client.query("commit")
    }
  } catch (error) {
    if (wrapped) {
      await client.query("rollback").catch(() => {})
    }
    throw error
  }
}

async function main() {
  const { command, migrationDir, fileArg } = parseArgs(process.argv)
  const migrations = readMigrations(migrationDir)

  if (command === "list") {
    for (const migration of migrations) {
      console.log(`${String(migration.index).padStart(3, " ")}  ${migration.file}`)
    }
    return
  }

  if (command === "plan-after") {
    if (!fileArg) fail("Missing last applied file for plan-after.")
    const last = findMigration(migrations, fileArg)
    console.log(`Last applied: #${last.index} ${last.file}`)
    console.log(`Next migration: ${migrations[last.index]?.file || "none"}`)
    console.log(`Remaining migrations: ${migrations.length - last.index}`)
    for (const migration of migrations.slice(last.index, last.index + 20)) {
      console.log(`${String(migration.index).padStart(3, " ")}  ${migration.file}`)
    }
    if (migrations.length - last.index > 20) {
      console.log(`... ${migrations.length - last.index - 20} more`)
    }
    return
  }

  const client = await connect()

  try {
    await ensureLogTable(client)

    if (command === "status") {
      const applied = await readApplied(client)
      console.log(`Migration directory: ${migrationDir}`)
      console.log(`Total files: ${migrations.length}`)
      console.log(`Logged as applied: ${applied.size}`)
      const next = migrations.find((migration) => !applied.has(migration.file))
      console.log(`Next migration: ${next ? `#${next.index} ${next.file}` : "none"}`)

      const changed = migrations.filter((migration) => {
        const existing = applied.get(migration.file)
        return existing && existing !== migration.checksum
      })

      if (changed.length > 0) {
        console.log("\nChecksum mismatches:")
        for (const migration of changed) {
          console.log(`- ${migration.file}`)
        }
        process.exitCode = 1
      }
      return
    }

    if (command === "mark-through") {
      if (!fileArg) fail("Missing last applied file for mark-through.")
      const through = findMigration(migrations, fileArg)

      await withLock(client, async () => {
        const applied = await readApplied(client)
        for (const migration of migrations.slice(0, through.index)) {
          const existing = applied.get(migration.file)
          if (existing && existing !== migration.checksum) {
            fail(`Checksum mismatch for already logged migration: ${migration.file}`)
          }
          if (existing) {
            console.log(`✓ already marked #${migration.index} ${migration.file}`)
            continue
          }

          await client.query(
            `
            insert into public.${MIGRATION_TABLE} (version, checksum, source)
            values ($1, $2, 'manual-copy-paste-before-runner')
            `,
            [migration.file, migration.checksum],
          )
          console.log(`✓ marked #${migration.index} ${migration.file}`)
        }
      })

      const next = migrations[through.index]
      console.log(`\nMarked through #${through.index} ${through.file}`)
      console.log(`Next migration to run: ${next ? `#${next.index} ${next.file}` : "none"}`)
      return
    }

    if (command === "up") {
      await withLock(client, async () => {
        const applied = await readApplied(client)
        for (const migration of migrations) {
          const existing = applied.get(migration.file)
          if (existing) {
            if (existing !== migration.checksum) {
              fail(`Checksum mismatch for applied migration: ${migration.file}`)
            }
            console.log(`✓ skipped #${migration.index} ${migration.file}`)
            continue
          }

          console.log(`→ running #${migration.index} ${migration.file}`)
          await runSqlMigration(client, migration)
          console.log(`✓ applied #${migration.index} ${migration.file}`)
        }
      })

      console.log("\nAll migrations are applied.")
      return
    }

    fail(`Unknown command "${command}".\n\n${USAGE}`)
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error("\nMigration failed.")
  console.error(error?.message || error)
  if (error?.position) console.error(`SQL position: ${error.position}`)
  if (error?.detail) console.error(`Detail: ${error.detail}`)
  if (error?.hint) console.error(`Hint: ${error.hint}`)
  process.exit(1)
})
