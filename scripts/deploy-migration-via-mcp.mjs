#!/usr/bin/env node
/**
 * Emit a content-verified deployment plan for one migration file.
 *
 * `scripts/supabase-migrate.cjs` is the canonical runner and needs a Postgres
 * connection string. The agent environment that performs the production deploy
 * has none — its only transport is the Supabase management API, which takes SQL
 * as a request parameter. That parameter has to be authored by the caller, and
 * for a 35 KB policy migration "authored by the caller" means retyped. A single
 * wrong character inside a USING clause weakens a policy without failing
 * anything, so retyping must never be trusted on its own.
 *
 * So this tool does not ask anyone to transcribe SQL correctly. It asks them to
 * transcribe it *verifiably*: the file is split into chunks, each chunk carries
 * the sha256 of its own bytes, and the database recomputes those hashes on what
 * it actually received. Nothing executes until the reassembled text hashes to
 * the same sha256 as the file on disk. A transcription slip cannot reach the
 * schema; it can only abort the deploy.
 *
 * Transport differs from the canonical runner. Semantics do not:
 *
 *   - checksum recorded in the ledger is sha256 of the raw file, byte for byte
 *     identical to what `supabase-migrate.cjs` would record;
 *   - the whole migration plus its ledger row run as one statement (a DO
 *     block), so they commit or roll back together;
 *   - re-running a recorded migration is refused, not silently repeated.
 *
 * The file's own `BEGIN;` / `COMMIT;` lines are removed before execution —
 * transaction control is illegal inside a DO block, and the DO block already
 * provides exactly the transaction they were asking for. That edit is derived
 * inside the database by a fixed rule and checked against a second hash
 * computed here, so it cannot become a place where content changes unnoticed.
 *
 * Usage:
 *   node scripts/deploy-migration-via-mcp.mjs <migration-file> [--out <dir>] [--chunk-bytes N]
 *
 * Writes numbered statements to <dir> and prints the order to run them in. Run
 * them in that order, stop on the first one that does not report ok.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** Transaction control the DO block replaces. Must match TXN_CONTROL_SQL_RE. */
const TXN_CONTROL_RE = /^[ \t]*(?:BEGIN|COMMIT)[ \t]*;[ \t]*$/gm
/** The same rule as a Postgres regexp, applied server-side to the staged text. */
const TXN_CONTROL_SQL_RE = '(?n)^[ \\t]*(BEGIN|COMMIT)[ \\t]*;[ \\t]*$'

const STAGING = 'public.nordklart_deploy_staging'
const LEDGER = 'public.nordklart_schema_migrations'

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex')

/** Dollar-quote tag that is not already present in the text. */
function safeTag(text) {
  for (let n = 0; ; n += 1) {
    const tag = `$nk_stage_${n}$`
    if (!text.includes(tag)) return tag
  }
}

/** Split on line boundaries so every chunk stays readable and diffable. */
function chunk(text, maxBytes) {
  const chunks = []
  let current = ''
  for (const line of text.split(/(?<=\n)/)) {
    if (current && Buffer.byteLength(current + line, 'utf8') > maxBytes) {
      chunks.push(current)
      current = ''
    }
    current += line
  }
  if (current) chunks.push(current)
  return chunks
}

function setupSql() {
  // Deny-all by construction: RLS on with no policies, and no grants to the
  // PostgREST roles. Only the service role reaches it, and only in transit.
  return `CREATE TABLE IF NOT EXISTS ${STAGING} (
  file text NOT NULL,
  idx integer NOT NULL,
  body text NOT NULL,
  expected_sha text NOT NULL,
  staged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file, idx)
);
ALTER TABLE ${STAGING} ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ${STAGING} FROM PUBLIC, anon, authenticated;
SELECT 'staging ready' AS ok;`
}

function chunkSql(file, index, body, tag) {
  return `WITH staged AS (
  INSERT INTO ${STAGING} (file, idx, body, expected_sha)
  VALUES (${quote(file)}, ${index}, ${tag}${body}${tag}, ${quote(sha256(body))})
  ON CONFLICT (file, idx) DO UPDATE
    SET body = EXCLUDED.body, expected_sha = EXCLUDED.expected_sha, staged_at = now()
  RETURNING idx, body, expected_sha
)
SELECT idx,
       encode(sha256(convert_to(body, 'UTF8')), 'hex') = expected_sha AS ok,
       octet_length(body) AS bytes
FROM staged;`
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function commitSql({ file, fileSha, execSha, chunks }) {
  return `DO $nk_deploy$
DECLARE
  v_file       text := ${quote(file)};
  v_file_sha   text := ${quote(fileSha)};
  v_exec_sha   text := ${quote(execSha)};
  v_chunks     integer := ${chunks};
  v_staged     integer;
  v_sql        text;
  v_exec       text;
  v_actual     text;
BEGIN
  SELECT count(*), string_agg(body, '' ORDER BY idx)
    INTO v_staged, v_sql
    FROM ${STAGING}
   WHERE file = v_file;

  IF v_staged <> v_chunks THEN
    RAISE EXCEPTION 'staged % chunk(s), expected % — re-stage before deploying', v_staged, v_chunks;
  END IF;

  v_actual := encode(sha256(convert_to(v_sql, 'UTF8')), 'hex');
  IF v_actual <> v_file_sha THEN
    RAISE EXCEPTION 'staged content is not the file: sha256 %, expected %', v_actual, v_file_sha;
  END IF;

  v_exec := regexp_replace(v_sql, ${quote(TXN_CONTROL_SQL_RE)}, '', 'g');
  v_actual := encode(sha256(convert_to(v_exec, 'UTF8')), 'hex');
  IF v_actual <> v_exec_sha THEN
    RAISE EXCEPTION 'transaction-control stripping diverged: sha256 %, expected %', v_actual, v_exec_sha;
  END IF;

  IF EXISTS (SELECT 1 FROM ${LEDGER} WHERE version = v_file) THEN
    RAISE EXCEPTION 'migration % is already recorded — refusing to re-run', v_file;
  END IF;

  EXECUTE v_exec;

  INSERT INTO ${LEDGER} (version, checksum, source)
  VALUES (v_file, v_file_sha, 'mcp-deploy');

  DELETE FROM ${STAGING} WHERE file = v_file;

  RAISE NOTICE 'deployed % (sha256 %)', v_file, v_file_sha;
END
$nk_deploy$;`
}

function main() {
  const args = process.argv.slice(2)
  const target = args.find((a) => !a.startsWith('--'))
  if (!target) {
    console.error('Usage: deploy-migration-via-mcp.mjs <migration-file> [--out <dir>] [--chunk-bytes N]')
    process.exit(1)
  }
  const flag = (name, fallback) => {
    const i = args.indexOf(name)
    return i === -1 ? fallback : args[i + 1]
  }
  const outDir = flag('--out', path.join('.deploy', path.basename(target, '.sql')))
  const chunkBytes = Number(flag('--chunk-bytes', '12000'))

  const raw = fs.readFileSync(target)
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    throw new Error('file starts with a UTF-8 BOM; the ledger checksum would not match the canonical runner')
  }
  const text = raw.toString('utf8')
  if (text.includes('\r')) {
    throw new Error('file contains CR; normalise line endings before deploying')
  }

  const fileSha = sha256(text)
  const execText = text.replace(TXN_CONTROL_RE, '')
  const execSha = sha256(execText)
  const file = path.basename(target)
  const tag = safeTag(text)
  const parts = chunk(text, chunkBytes)

  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const steps = []
  const write = (name, sql) => {
    fs.writeFileSync(path.join(outDir, name), `${sql}\n`)
    steps.push(name)
  }

  write('00-setup.sql', setupSql())
  parts.forEach((body, i) => {
    write(`${String(i + 1).padStart(2, '0')}-chunk.sql`, chunkSql(file, i + 1, body, tag))
  })
  write(`${String(parts.length + 1).padStart(2, '0')}-deploy.sql`, commitSql({
    file, fileSha, execSha, chunks: parts.length,
  }))

  console.log(`file        ${file}`)
  console.log(`bytes       ${Buffer.byteLength(text, 'utf8')}`)
  console.log(`file sha256 ${fileSha}`)
  console.log(`exec sha256 ${execSha}`)
  console.log(`chunks      ${parts.length} (<= ${chunkBytes} bytes each)`)
  console.log(`out         ${outDir}`)
  console.log('\nRun in order; stop on the first statement that does not report ok:')
  for (const step of steps) console.log(`  ${path.join(outDir, step)}`)
}

main()
