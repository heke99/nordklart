#!/usr/bin/env node
/**
 * Service-role surface ratchet.
 *
 * A service-role Supabase client bypasses RLS entirely, so every call site is
 * a place where tenant isolation depends on hand-written checks rather than on
 * the database. The 2026-08-08 review walked all 108 existing call sites and
 * confirmed each one verifies actor -> company -> resource -> permission before
 * the privileged operation (docs/audits/2026-08-08-service-role-review.md).
 *
 * This guard freezes that surface: a NEW file constructing a service-role
 * client fails the build until it is reviewed and added to the baseline. It
 * does not try to prove correctness of the checks inside a file — that is what
 * the review and the pg-real tenant-isolation matrix are for — it only makes
 * growth of the surface deliberate instead of silent.
 *
 * Removing a call site is always allowed and shrinks the baseline on the next
 * regeneration; the guard reports stale entries so the file stays honest.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const SCAN_DIRS = ['app', 'lib', 'extensions']
const CONSTRUCTORS = ['createServiceClient()', 'createServiceClientNoCookies()']
const baselinePath = 'scripts/checks/service-role-baseline.json'

/** Test files get their own service clients against throwaway data. */
function isTest(file) {
  return file.includes('__tests__/') || file.endsWith('.test.ts') || file.endsWith('.test.tsx')
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      walk(rel, out)
    } else if (/\.tsx?$/.test(entry.name) && !isTest(rel)) {
      out.push(rel)
    }
  }
  return out
}

const found = []
for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(path.join(root, dir))) continue
  for (const file of walk(dir, [])) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    if (CONSTRUCTORS.some((c) => source.includes(c))) found.push(file)
  }
}
found.sort()

const baseline = JSON.parse(fs.readFileSync(path.join(root, baselinePath), 'utf8'))
const allowed = new Set(baseline.allowed)

const added = found.filter((f) => !allowed.has(f))
const stale = baseline.allowed.filter((f) => !found.includes(f))

if (stale.length > 0) {
  console.log(
    `service-role surface: ${stale.length} baseline entr${stale.length === 1 ? 'y no longer constructs' : 'ies no longer construct'} a service-role client (safe to prune):`,
  )
  for (const file of stale) console.log(`  - ${file}`)
}

if (added.length > 0) {
  console.error('')
  console.error('ERROR: new service-role client call site(s) outside the reviewed baseline:')
  for (const file of added) console.error(`  + ${file}`)
  console.error('')
  console.error('A service-role client bypasses RLS. Before adding the file to')
  console.error(`${baselinePath}, confirm the code verifies the authenticated actor's`)
  console.error('access to the company AND the specific resource, and that every query is')
  console.error('filtered by company_id. See docs/audits/2026-08-08-service-role-review.md.')
  process.exit(1)
}

console.log(`service-role surface OK — ${found.length} reviewed call sites, 0 new.`)
