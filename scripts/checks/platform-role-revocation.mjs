#!/usr/bin/env node
/**
 * Platform-role revocation guard.
 *
 * `platform_roles` records revocation instead of deleting the grant
 * (`revoked_at`), so a query that only matches on `user_id` + `role` still
 * returns rows for operators whose access was taken away. Two authorization
 * checks were written that way (finding #21, 2026-08-08): the platform
 * troubleshooting export and the deep health endpoint both kept authorizing
 * revoked operators.
 *
 * This guard requires every `.from('platform_roles')` query in application code
 * to either filter `.is('revoked_at', null)` or select `revoked_at` as data —
 * the latter is the admin listing screen, which must show revoked grants.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const SCAN_DIRS = ['app', 'lib', 'extensions']
/** Lines of context in which the predicate must appear (Supabase chains are short). */
const WINDOW = 12

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

const failures = []
let checked = 0

for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(path.join(root, dir))) continue
  for (const file of walk(dir, [])) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!line.includes("from('platform_roles')") && !line.includes('from("platform_roles")')) return
      checked += 1
      const window = lines.slice(i, i + WINDOW).join('\n')
      const filtersRevoked = /\.is\(\s*['"]revoked_at['"]\s*,\s*null\s*\)/.test(window)
      const selectsRevoked = /select\([^)]*revoked_at/.test(window) || /revoked_at/.test(line)
      if (!filtersRevoked && !selectsRevoked) {
        failures.push(`${file}:${i + 1}`)
      }
    })
  }
}

if (failures.length > 0) {
  console.error('ERROR: platform_roles query without a revocation predicate:')
  for (const where of failures) console.error(`  - ${where}`)
  console.error('')
  console.error("Add .is('revoked_at', null) — a revoked grant is not a role. If the query")
  console.error('deliberately lists revoked grants, select revoked_at so the intent is explicit.')
  process.exit(1)
}

console.log(`Platform-role revocation guard OK — ${checked} platform_roles quer${checked === 1 ? 'y' : 'ies'} checked.`)
