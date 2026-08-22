#!/usr/bin/env node
/**
 * Fail fast when a client component can reach a server-only module.
 *
 * `lib/supabase/server.ts` imports `next/headers`. `lib/bookkeeping/engine.ts`
 * imported it at module scope, and `invoice-entries.ts` imported the engine —
 * so `propose-send-lines.ts`, documented as a pure preview helper with "no DB
 * or Supabase dependency", dragged `next/headers` into the browser bundle the
 * moment `SendInvoiceDialog.tsx` imported it. `next build` rejects that; tsc
 * and vitest do not, because neither traces client boundaries. The failure
 * therefore only appeared in CI, minutes later, as a wall of import traces.
 *
 * This guard walks the same graph statically in about a second.
 *
 * Two things worth knowing before "fixing" a violation:
 *
 *  - A dynamic `await import()` does NOT break the chain. Turbopack traces it
 *    into the client module graph just like a static one. This guard follows
 *    dynamic imports for exactly that reason. The real fix is to split the
 *    pure part into its own module (see `lib/bookkeeping/revenue-accounts.ts`).
 *  - `import type` is erased before bundling and is not followed.
 *
 *   node scripts/checks/client-server-boundary.mjs
 *   node scripts/checks/client-server-boundary.mjs --list   # client entrypoints
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()

// Modules that must never end up in a browser bundle. `server-only` throws at
// build time by design; `next/headers` is request-scoped server state.
const SERVER_ONLY = new Set(['next/headers', 'server-only', 'next/server'])

const SEARCH_DIRS = ['app', 'components', 'lib', 'extensions', 'hooks', 'contexts']
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '_generated') continue
      walk(full, out)
    } else if (EXTENSIONS.includes(path.extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

const allFiles = SEARCH_DIRS.flatMap((d) => walk(path.join(root, d)))

/** Files under __tests__ are never bundled. */
const isTest = (f) => f.includes(`${path.sep}__tests__${path.sep}`) || /\.test\.[jt]sx?$/.test(f)

/**
 * Every import specifier in `src`, excluding type-only imports.
 *
 * Type-only imports are erased by the compiler and cannot pull a runtime
 * module into a bundle, so following them would produce false violations on
 * files that only borrow a type from a server module.
 */
function importsOf(src) {
  const specs = []
  const statik = /(?:^|\n)\s*import\s+(?!type\s)([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g
  const bare = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = statik.exec(src))) {
    // `import { type A, b }` still has a runtime half; `import { type A }`
    // does not, but treating it as runtime only costs a followed edge.
    specs.push(m[2])
  }
  while ((m = bare.exec(src))) specs.push(m[1])
  while ((m = dynamic.exec(src))) specs.push(m[1])
  return specs
}

/** Resolve a specifier to a repo file, or null for externals/unresolvable. */
function resolve(spec, fromFile) {
  let base
  if (spec.startsWith('@/')) base = path.join(root, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  else return null

  for (const ext of EXTENSIONS) {
    if (fs.existsSync(base + ext)) return base + ext
  }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const ext of EXTENSIONS) {
      const idx = path.join(base, 'index' + ext)
      if (fs.existsSync(idx)) return idx
    }
  }
  return fs.existsSync(base) && fs.statSync(base).isFile() ? base : null
}

const srcCache = new Map()
function read(file) {
  if (!srcCache.has(file)) srcCache.set(file, fs.readFileSync(file, 'utf8'))
  return srcCache.get(file)
}

const rel = (f) => path.relative(root, f)

/**
 * A `'use server'` file is a real boundary, not a violation: the bundler
 * replaces its exports with RPC stubs on the client, so nothing it imports is
 * bundled. Importing a Server Action from a client component is the supported
 * pattern (`lib/company/actions.ts` ← `CompanySwitcher.tsx`), and traversing
 * into it would flag every one of them.
 */
const isServerAction = (f) => /^\s*(['"])use server\1/.test(read(f).replace(/^\ufeff/, ''))

const isClientEntry = (f) =>
  !isTest(f) && /^\s*(['"])use client\1/.test(read(f).replace(/^﻿/, ''))

const clientEntries = allFiles.filter(isClientEntry)

if (process.argv.includes('--list')) {
  clientEntries.forEach((f) => console.log(rel(f)))
  process.exit(0)
}

/**
 * Depth-first from each client entrypoint, stopping at the first server-only
 * import so the reported trace is the shortest one — the long traces `next
 * build` prints are the hard part of reading this failure.
 */
const violations = []
const clean = new Set() // files proven not to reach a server-only module

function trace(file, stack, seen) {
  const src = read(file)
  for (const spec of importsOf(src)) {
    if (SERVER_ONLY.has(spec)) return [...stack, `${spec} (server-only)`]
    const target = resolve(spec, file)
    if (!target || seen.has(target) || clean.has(target) || isTest(target)) continue
    if (isServerAction(target)) continue
    seen.add(target)
    const found = trace(target, [...stack, rel(target)], seen)
    if (found) return found
    clean.add(target)
  }
  return null
}

for (const entry of clientEntries) {
  const found = trace(entry, [rel(entry)], new Set([entry]))
  if (found) violations.push(found)
}

if (violations.length > 0) {
  console.error(
    `client-server-boundary: ${violations.length} client component(s) reach a server-only module.\n`,
  )
  for (const chain of violations) {
    console.error('  ' + chain.join('\n    → '))
    console.error('')
  }
  console.error(
    'Split the part the client actually needs into its own dependency-free module.\n' +
      'A dynamic import() does not help — Turbopack traces it into the client graph too.',
  )
  process.exit(1)
}

console.log(
  `client-server-boundary OK — ${clientEntries.length} client entrypoints, ` +
    `none reaches ${[...SERVER_ONLY].join('/')}.`,
)
