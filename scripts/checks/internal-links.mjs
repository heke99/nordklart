#!/usr/bin/env node
/**
 * Fail the build on an internal link that has no route behind it.
 *
 * Two live 404s motivated this guard, both behind visible buttons:
 *   - `/documents` — the primary "Ladda upp kvitto" CTA on /receipts, and the
 *     "Öppna underlag" card next to it.
 *   - `/inbox` — an actionable item on /automation reading
 *     "Hantera N dokument i inkorgen".
 *
 * Neither existed. There is no `app/**\/documents/page.tsx`, no middleware
 * rewrite, and no redirect in next.config.ts. Both had presumably been renamed
 * at some point and the callers were missed, which nothing was checking for.
 *
 * Scope: literal internal paths only. A template literal or a variable is not
 * resolvable statically and is skipped rather than guessed at — this guard
 * exists to catch the dead constant, not to prove every link at runtime.
 *
 *   node scripts/checks/internal-links.mjs
 *   node scripts/checks/internal-links.mjs --list   # print the resolved routes
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const APP = path.join(root, 'app')

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue
      walk(full, out)
    } else out.push(full)
  }
  return out
}

/**
 * app/(dashboard)/invoices/[id]/page.tsx  →  /invoices/[id]
 * Route groups `(x)`, parallel slots `@x` and intercepting `(.)x` segments do
 * not appear in the URL.
 */
function routeForPageFile(file) {
  const rel = path.relative(APP, path.dirname(file))
  if (rel.startsWith('..')) return null
  const segments = rel === '.' ? [] : rel.split(path.sep)
  const kept = []
  for (const segment of segments) {
    if (segment.startsWith('@')) return null            // parallel slot
    if (/^\(\.{1,3}\)/.test(segment)) return null       // intercepting route
    if (segment.startsWith('(') && segment.endsWith(')')) continue // route group
    kept.push(segment)
  }
  return '/' + kept.join('/')
}

function routeToRegExp(route) {
  const parts = route.split('/').filter(Boolean).map((segment) => {
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) return '(?:/.*)?'  // optional catch-all
    if (/^\[\.\.\..+\]$/.test(segment)) return '/.+'           // catch-all
    if (/^\[.+\]$/.test(segment)) return '/[^/]+'              // dynamic
    return '/' + segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  })
  return new RegExp('^' + (parts.join('') || '/') + '$')
}

const pageFiles = fs.existsSync(APP)
  ? walk(APP).filter((f) => /(^|[\\/])page\.tsx$/.test(f))
  : []
const routes = [...new Set(pageFiles.map(routeForPageFile).filter(Boolean))]
const routeMatchers = routes.map(routeToRegExp)

// Redirect sources count as reachable destinations too.
const nextConfig = fs.existsSync(path.join(root, 'next.config.ts'))
  ? fs.readFileSync(path.join(root, 'next.config.ts'), 'utf8')
  : ''
const redirectSources = [...nextConfig.matchAll(/source:\s*'([^']+)'/g)]
  .map((m) => m[1].replace(/:\w+\*?/g, '[x]'))
const redirectMatchers = redirectSources.map(routeToRegExp)

if (process.argv.includes('--list')) {
  for (const route of routes.sort()) console.log(route)
  process.exit(0)
}

const LINK_PATTERNS = [
  /href=["'](\/[^"'{}]*)["']/g,
  /href=\{["'](\/[^"'{}]*)["']\}/g,
  /router\.(?:push|replace)\(\s*["'](\/[^"'{}]*)["']/g,
  /\bredirect\(\s*["'](\/[^"'{}]*)["']/g,
]

function isCheckable(href) {
  const [pathname] = href.split(/[?#]/)
  if (!pathname.startsWith('/')) return false
  if (pathname.startsWith('//')) return false          // protocol-relative
  if (pathname.startsWith('/api/')) return false       // route handlers
  if (pathname.startsWith('/_next/')) return false
  if (/\.[a-z0-9]{2,5}$/i.test(pathname)) return false // a file in public/
  return true
}

const sources = [
  ...(fs.existsSync(APP) ? walk(APP) : []),
  ...(fs.existsSync(path.join(root, 'components')) ? walk(path.join(root, 'components')) : []),
].filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))

const broken = new Map()
for (const file of sources) {
  const text = fs.readFileSync(file, 'utf8')
  for (const pattern of LINK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const href = match[1]
      if (!isCheckable(href)) continue
      const [pathname] = href.split(/[?#]/)
      const target = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname
      if (routeMatchers.some((re) => re.test(target))) continue
      if (redirectMatchers.some((re) => re.test(target))) continue
      const rel = path.relative(root, file)
      if (!broken.has(target)) broken.set(target, new Set())
      broken.get(target).add(rel)
    }
  }
}

if (broken.size > 0) {
  console.error('internal-links: link(s) with no route behind them:')
  for (const [target, files] of [...broken].sort()) {
    console.error(`  ${target}`)
    for (const file of [...files].sort()) console.error(`      ${file}`)
  }
  console.error('\nEither point the link at a real route or add a redirect in next.config.ts.')
  process.exit(1)
}

console.log(`internal-links OK — ${routes.length} routes, every literal internal link resolves.`)
