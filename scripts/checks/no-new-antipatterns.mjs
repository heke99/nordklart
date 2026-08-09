#!/usr/bin/env node
/**
 * Ratchet guard against post-audit antipatterns.
 *
 * The audit found two repository-wide problems that are being remediated in
 * dedicated campaigns (A1 = route auth/MFA, D1 = money rounding). Those touch
 * hundreds of sites and won't land in one PR — so this guard makes sure the
 * count can only go DOWN, never up, while the migrations are in flight.
 *
 * Checks:
 *   1. raw-route-auth  — an `app/api/**\/route.ts` that calls
 *      `supabase.auth.getUser()` directly instead of going through
 *      `requireAuth()` / `withRouteContext()` (the only guards that enforce
 *      MFA AAL2 on hosted). Tracked as a file-set so a NEW offending route
 *      fails CI even if an old one was fixed in the same PR.
 *   2. naive-ore-round — `Math.round(x * 100) / 100`, which is subtly wrong on
 *      exact-half values (see lib/money.ts `roundOre`). Tracked as a count.
 *      The canonical rounding modules are excluded.
 *   3. migration-missing-rls — a migration that CREATE TABLEs in the public
 *      schema without ENABLE ROW LEVEL SECURITY on that table in the same
 *      file. Every public table is reachable over PostgREST; a table without
 *      RLS is readable/writable by any authenticated caller. Tracked as an
 *      entry-set (migration#table) so new offenders fail even when legacy
 *      ones remain.
 *   4. duplicate-migration-version — more than one SQL migration with the
 *      same leading timestamp. The two legacy duplicate sets are tracked by
 *      exact filename signature; neither a new duplicate nor a third file in
 *      a legacy set is allowed.
 *
 * Usage:
 *   node scripts/checks/no-new-antipatterns.mjs            # check (CI)
 *   node scripts/checks/no-new-antipatterns.mjs --update   # re-baseline after a migration ratchets the count down
 *
 * Exit code 1 if either check regressed past its baseline.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'checks', 'antipatterns-baseline.json')

const IGNORE_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage'])
// The sanctioned home of the öre-round implementation — must not count against itself.
const ROUND_EXEMPT = new Set(['lib/money.ts', 'lib/bokslut/rounding.ts'])

const RAW_AUTH_RE = /\.auth\.getUser\(/
// Match the guard at its CALL site, not a bare import, so a file that imports
// withRouteContext but still hand-rolls getUser() on another handler is still
// flagged. withRouteContext is usually called with a generic (`withRouteContext<…>(`),
// so accept either `<` or `(` after the name.
const GUARD_RE = /requireAuth\(|withRouteContext[<(]/
const NAIVE_ROUND_RE = /Math\.round\([^\n]*\*\s*100\s*\)\s*\/\s*100/
// `NextResponse.json({ error: 'text' …` — a bare string where the canonical
// envelope `{ error: { code, message, … } }` belongs.
const ADHOC_ERROR_RE = /NextResponse\.json\(\s*\{\s*error:\s*['"`]/
const CANONICAL_ERROR_RE = /errorResponse\(|errorResponseFromCode\(|v1ErrorResponse\(/

function walk(dir, exts, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.well-known') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!IGNORE_DIRS.has(e.name)) walk(full, exts, out)
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full)
    }
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')

/** Route files that hand-roll auth instead of the MFA-enforcing guard. */
function findRawRouteAuth() {
  const apiDir = path.join(ROOT, 'app', 'api')
  return walk(apiDir, ['route.ts'])
    .filter((f) => {
      const src = fs.readFileSync(f, 'utf8')
      return RAW_AUTH_RE.test(src) && !GUARD_RE.test(src)
    })
    .map(rel)
    .sort()
}

/** Count of naive Math.round(x*100)/100 occurrences (lines) across source. */
function countNaiveRound() {
  const files = [
    ...walk(path.join(ROOT, 'lib'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'app'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'components'), ['.ts', '.tsx']),
    ...walk(path.join(ROOT, 'extensions'), ['.ts', '.tsx']),
  ]
  let count = 0
  for (const f of files) {
    if (ROUND_EXEMPT.has(rel(f))) continue
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (NAIVE_ROUND_RE.test(line)) count++
    }
  }
  return count
}

/**
 * Migration files that create a public table without enabling RLS on it in
 * the same file. Reported as `file#table` entries.
 */
function findMigrationsMissingRls() {
  const dir = path.join(ROOT, 'supabase', 'migrations')
  let files
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))
  } catch {
    return []
  }
  const offenders = []
  const CREATE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/g
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').toLowerCase()
    // Generated skill-body seed migrations contain documentation examples as
    // dollar-quoted text. Those examples may include `CREATE TABLE` snippets,
    // but the migration itself only INSERTs into agent_atom_registry. Do not
    // treat embedded reference text as executable migration DDL.
    const isGeneratedSkillBodySeed =
      src.includes('auto-generated by scripts/generate-skill-bodies.ts') &&
      src.includes('insert into public.agent_atom_registry')
    if (isGeneratedSkillBodySeed) continue
    const created = new Set()
    for (const m of src.matchAll(CREATE_RE)) created.add(m[1])
    for (const table of created) {
      const rlsRe = new RegExp(
        `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:"?public"?\\.)?"?${table}"?\\s+enable\\s+row\\s+level\\s+security`,
      )
      // Dynamic (format()-based) RLS enabling inside DO blocks can't be
      // statically matched per table — accept a file-level dynamic marker.
      const dynamicRls = src.includes('enable row level security') && src.includes('execute format(')
      if (!rlsRe.test(src) && !dynamicRls) {
        offenders.push(`supabase/migrations/${f}#${table}`)
      }
    }
  }
  return offenders.sort()
}

function findDuplicateMigrationVersions() {
  const dir = path.join(ROOT, 'supabase', 'migrations')
  let files
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f))
  } catch {
    return []
  }

  const byVersion = new Map()
  for (const file of files) {
    const version = file.split('_', 1)[0]
    const versionFiles = byVersion.get(version) ?? []
    versionFiles.push(file)
    byVersion.set(version, versionFiles)
  }

  return [...byVersion.entries()]
    .filter(([, versionFiles]) => versionFiles.length > 1)
    .map(([version, versionFiles]) => `${version}:${versionFiles.sort().join(',')}`)
    .sort()
}

/**
 * Route files whose failure path is a hand-built `{ error: 'text' }` body and
 * that never reach for a canonical helper. The contract is
 * `{ error: { code, message, message_en?, requestId? } }` — a bare string
 * gives clients nothing to branch on and no request id to trace with. The
 * legacy set is large and is being converted route family by route family;
 * this only stops it growing.
 */
function findAdhocErrorEnvelopes() {
  const apiDir = path.join(ROOT, 'app', 'api')
  return walk(apiDir, ['route.ts'])
    .filter((f) => {
      const src = fs.readFileSync(f, 'utf8')
      return ADHOC_ERROR_RE.test(src) && !CANONICAL_ERROR_RE.test(src)
    })
    .map(rel)
    .sort()
}

const current = {
  rawRouteAuth: findRawRouteAuth(),
  naiveOreRound: countNaiveRound(),
  migrationsMissingRls: findMigrationsMissingRls(),
  duplicateMigrationVersions: findDuplicateMigrationVersions(),
  adhocErrorEnvelope: findAdhocErrorEnvelopes(),
}

const isUpdate = process.argv.includes('--update')

if (isUpdate) {
  const baseline = {
    _comment:
      'Ratchet baseline for scripts/checks/no-new-antipatterns.mjs. These counts may only decrease. Re-run with --update after a migration lowers them. Goal: all reach 0 (A1 route-auth campaign, D1 rounding codemod, RLS backfill).',
    rawRouteAuth: { count: current.rawRouteAuth.length, files: current.rawRouteAuth },
    naiveOreRound: { count: current.naiveOreRound },
    migrationsMissingRls: { count: current.migrationsMissingRls.length, entries: current.migrationsMissingRls },
    duplicateMigrationVersions: {
      count: current.duplicateMigrationVersions.length,
      entries: current.duplicateMigrationVersions,
    },
    adhocErrorEnvelope: {
      count: current.adhocErrorEnvelope.length,
      files: current.adhocErrorEnvelope,
    },
  }
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
  console.log(
    `Baseline written: ${current.rawRouteAuth.length} raw-route-auth files, ${current.naiveOreRound} naive-ore-round occurrences, ${current.migrationsMissingRls.length} migration-missing-rls entries.`,
  )
  process.exit(0)
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.error('No baseline found. Run: node scripts/checks/no-new-antipatterns.mjs --update')
  process.exit(1)
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
let failed = false

// 1. raw-route-auth: any file not in the baseline set is a NEW violation.
const baselineSet = new Set(baseline.rawRouteAuth.files)
const newAuthFiles = current.rawRouteAuth.filter((f) => !baselineSet.has(f))
const fixedAuthFiles = baseline.rawRouteAuth.files.filter((f) => !current.rawRouteAuth.includes(f))
if (newAuthFiles.length) {
  failed = true
  console.error(
    `\n✗ raw-route-auth: ${newAuthFiles.length} new route(s) call supabase.auth.getUser() directly ` +
      `instead of requireAuth()/withRouteContext() (skips MFA AAL2 enforcement):`,
  )
  newAuthFiles.forEach((f) => console.error(`    ${f}`))
  console.error('  → wrap the route in withRouteContext (or call requireAuth) so MFA is enforced.')
}

// 2. naive-ore-round: count may not increase.
if (current.naiveOreRound > baseline.naiveOreRound.count) {
  failed = true
  console.error(
    `\n✗ naive-ore-round: ${current.naiveOreRound} occurrences of Math.round(x*100)/100 ` +
      `(baseline ${baseline.naiveOreRound.count}, +${current.naiveOreRound - baseline.naiveOreRound.count}).`,
  )
  console.error('  → import roundOre from @/lib/money instead.')
}

// 3. migration-missing-rls: any entry not in the baseline set is a NEW violation.
const rlsBaselineSet = new Set(baseline.migrationsMissingRls?.entries ?? [])
const newRlsEntries = current.migrationsMissingRls.filter((e) => !rlsBaselineSet.has(e))
if (newRlsEntries.length) {
  failed = true
  console.error(
    `\n✗ migration-missing-rls: ${newRlsEntries.length} new public table(s) created without ENABLE ROW LEVEL SECURITY:`,
  )
  newRlsEntries.forEach((e) => console.error(`    ${e}`))
  console.error('  → add ALTER TABLE public.<table> ENABLE ROW LEVEL SECURITY (plus policies) in the same migration.')
}

// 4. duplicate migration versions: exact legacy filename sets are allowlisted.
const duplicateMigrationBaselineSet = new Set(
  baseline.duplicateMigrationVersions?.entries ?? [],
)
const newDuplicateMigrationVersions = current.duplicateMigrationVersions.filter(
  (entry) => !duplicateMigrationBaselineSet.has(entry),
)
if (newDuplicateMigrationVersions.length) {
  failed = true
  console.error(
    `\n✗ duplicate-migration-version: ${newDuplicateMigrationVersions.length} new or changed duplicate timestamp set(s):`,
  )
  newDuplicateMigrationVersions.forEach((entry) => console.error(`    ${entry}`))
  console.error('  → assign every new migration a unique, monotonically increasing timestamp.')
}

// 5. ad-hoc error envelope: any route not in the baseline set is a NEW violation.
const adhocBaselineSet = new Set(baseline.adhocErrorEnvelope?.files ?? [])
const newAdhocFiles = current.adhocErrorEnvelope.filter((f) => !adhocBaselineSet.has(f))
if (newAdhocFiles.length) {
  failed = true
  console.error(
    `\n✗ adhoc-error-envelope: ${newAdhocFiles.length} new route(s) return a bare ` +
      `{ error: 'text' } body instead of the canonical { error: { code, message } } envelope:`,
  )
  newAdhocFiles.forEach((f) => console.error(`    ${f}`))
  console.error('  → throw a typed error and let withRouteContext map it, or call errorResponseFromCode().')
}

// Report ratchet-down progress (informational, never fails).
if (fixedAuthFiles.length || current.naiveOreRound < baseline.naiveOreRound.count) {
  console.log('\n✓ Progress since baseline:')
  if (fixedAuthFiles.length) console.log(`    raw-route-auth: -${fixedAuthFiles.length} file(s)`)
  if (current.naiveOreRound < baseline.naiveOreRound.count)
    console.log(`    naive-ore-round: -${baseline.naiveOreRound.count - current.naiveOreRound} occurrence(s)`)
  console.log('    Run with --update to ratchet the baseline down and lock in the gains.')
}

if (failed) {
  console.error('\nAntipattern guard failed — see above.')
  process.exit(1)
}
console.log(
  `\n✓ Antipattern guard passed (raw-route-auth: ${current.rawRouteAuth.length}, naive-ore-round: ${current.naiveOreRound}, adhoc-error-envelope: ${current.adhocErrorEnvelope.length}, legacy-duplicate-migration-sets: ${current.duplicateMigrationVersions.length}).`,
)
