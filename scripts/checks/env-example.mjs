#!/usr/bin/env node
/**
 * Keeps `.env.example` honest.
 *
 * The file did not exist at all until this guard was written, and
 * `docker-entrypoint.sh` pointed operators at a `.env.docker.example` that was
 * never in the repository — so the only way to learn what a deployment needs
 * was to read 117 `process.env` references. An example file that is written
 * once and then drifts is barely better, so this guard fails when code reads a
 * variable the example does not mention.
 *
 * It is a completeness check, not a value check: nothing here knows or cares
 * what a variable should be set to, only that an operator can discover it.
 *
 * `--write` appends the missing names under an "unclassified" heading so the
 * fix is one command plus an edit to say what each one is for.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const EXAMPLE = '.env.example'
const SCAN_DIRS = ['app', 'lib', 'components', 'extensions', 'middleware.ts', 'next.config.ts']

/**
 * Variables the runtime or the platform provides. Naming them in an example
 * file would invite someone to set them by hand, which is worse than silence.
 */
const PLATFORM_PROVIDED = new Set([
  'NODE_ENV',
  'PORT',
  'HOSTNAME',
  'CI',
  'TZ',
  'npm_package_version',
  'VITEST',
  'VITEST_PG_REAL',
  'DATABASE_URL',
])

const PLATFORM_PREFIXES = ['VERCEL_', 'NEXT_RUNTIME', 'AWS_LAMBDA_', 'npm_']

function isPlatformProvided(name) {
  return PLATFORM_PROVIDED.has(name) || PLATFORM_PREFIXES.some((p) => name.startsWith(p))
}

function walk(entry, out) {
  const abs = path.join(root, entry)
  if (!fs.existsSync(abs)) return out
  const stat = fs.statSync(abs)
  if (stat.isFile()) {
    if (/\.(tsx?|mjs|cjs)$/.test(entry)) out.push(entry)
    return out
  }
  for (const child of fs.readdirSync(abs, { withFileTypes: true })) {
    if (child.name === 'node_modules' || child.name === '.next') continue
    walk(path.join(entry, child.name), out)
  }
  return out
}

const files = SCAN_DIRS.flatMap((dir) => walk(dir, []))
const used = new Map() // name -> first file that reads it

for (const file of files) {
  // Tests set their own environment; they are not deployment configuration.
  if (file.includes('__tests__/') || /\.test\.tsx?$/.test(file)) continue
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    const name = match[1]
    if (isPlatformProvided(name)) continue
    if (!used.has(name)) used.set(name, file)
  }
  // `process.env['NAME']` and destructuring both appear in the codebase.
  for (const match of source.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) {
    const name = match[1]
    if (isPlatformProvided(name)) continue
    if (!used.has(name)) used.set(name, file)
  }

  // Indirect reads. `lib/skatteverket/sysorg/config.ts` resolves everything
  // through firstEnv()/boolEnv() helpers that index process.env by a variable,
  // so a scan for `process.env.NAME` sees none of the ~12 Skatteverket
  // variables — the exact set an operator most needs written down. The same
  // shape appears in the requirement table's `aliases` arrays.
  for (const match of source.matchAll(/\b(?:firstEnv|boolEnv)\(([^)]*)\)/g)) {
    for (const nameMatch of match[1].matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g)) {
      const name = nameMatch[1]
      if (isPlatformProvided(name)) continue
      if (!used.has(name)) used.set(name, file)
    }
  }
  // `lib/platform/integration-readiness.ts` is handed an env record and reads
  // it as `env.NAME` / `groupState(env, [...])` / `missingEnvVars: [...]`. It is
  // the panel that tells an operator what to configure, so anything it names has
  // to be in this file by definition.
  for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) {
    const name = match[1]
    if (isPlatformProvided(name)) continue
    if (!used.has(name)) used.set(name, file)
  }
  for (const match of source.matchAll(/(?:missingEnvVars|groupState\(env,)\s*:?\s*\[([^\]]*)\]/g)) {
    for (const nameMatch of match[1].matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g)) {
      const name = nameMatch[1]
      if (isPlatformProvided(name)) continue
      if (!used.has(name)) used.set(name, file)
    }
  }
  for (const match of source.matchAll(/aliases:\s*\[([^\]]*)\]/g)) {
    for (const nameMatch of match[1].matchAll(/['"]([A-Z][A-Z0-9_]*)['"]/g)) {
      const name = nameMatch[1]
      if (isPlatformProvided(name)) continue
      if (!used.has(name)) used.set(name, file)
    }
  }
}

const examplePath = path.join(root, EXAMPLE)
if (!fs.existsSync(examplePath)) {
  console.error(`ERROR: ${EXAMPLE} is missing. Run: node scripts/checks/env-example.mjs --write`)
  process.exit(1)
}

const example = fs.readFileSync(examplePath, 'utf8')
const documented = new Set(
  [...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
)

const missing = [...used.keys()].filter((name) => !documented.has(name)).sort()
const stale = [...documented].filter((name) => !used.has(name)).sort()

if (process.argv.includes('--write') && missing.length > 0) {
  const block = [
    '',
    '# ─── Unclassified ────────────────────────────────────────────────────────',
    '# Added by scripts/checks/env-example.mjs --write. Move each of these into',
    '# the right section above and say what it is for, then delete this heading.',
    ...missing.map((name) => `# ${name}=`),
    '',
  ].join('\n')
  fs.writeFileSync(examplePath, example.trimEnd() + '\n' + block)
  console.log(`Appended ${missing.length} undocumented variable(s) to ${EXAMPLE}.`)
  process.exit(0)
}

if (missing.length > 0) {
  console.error(`\nERROR: ${missing.length} environment variable(s) are read by code but absent from ${EXAMPLE}:`)
  for (const name of missing) console.error(`  + ${name}  (${used.get(name)})`)
  console.error(`\nAdd them with a one-line comment saying what they are for, or run:`)
  console.error(`  node scripts/checks/env-example.mjs --write\n`)
  process.exit(1)
}

// Stale entries are reported, not fatal: an example may legitimately document
// something only the Docker entrypoint or a deploy script reads.
if (stale.length > 0) {
  console.log(`${EXAMPLE} documents ${stale.length} variable(s) not read by app code: ${stale.join(', ')}`)
}

console.log(`${EXAMPLE} OK — ${used.size} variable(s) read by code, all documented.`)
