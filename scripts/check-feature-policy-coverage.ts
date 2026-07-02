import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

type Finding = { file: string; reason: string }

const API_ROOT = join(process.cwd(), 'app', 'api')
const PROTECTED_SEGMENTS = [
  'assets',
  'bookkeeping',
  'expenses',
  'invoices',
  'reports',
  'vat',
  'skatteverket',
  'bank',
  'bankgiro',
]

function walk(dir: string): string[] {
  const entries = readdirSync(dir)
  return entries.flatMap((entry) => {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) return walk(path)
    return path.endsWith('route.ts') ? [path] : []
  })
}

// Routes under protected segments that are deliberately NOT feature-gated.
// Every entry needs a reason — this list is reviewed, not a dumping ground.
const EXEMPT_ROUTES = new Set<string>([
  // Public endpoint: customers respond to reminder emails via a signed token.
  // No session, no company context — gating on the company's plan would break
  // the customer-facing action link.
  'invoices/reminders/action/route.ts',
  // Platform-admin diagnostics (requirePlatformRole) — internal ops tooling,
  // not a user-facing commercial surface.
  'skatteverket/sysorg/status/route.ts',
  'skatteverket/sysorg/token-test/route.ts',
  // Static BAS reference lookup (no company data). Supports dialogs inside
  // bookkeeping surfaces that are themselves feature-gated.
  'bookkeeping/accounts/bas-lookup/route.ts',
])

function routeLooksProtected(file: string): boolean {
  const normalized = relative(API_ROOT, file).replaceAll('\\', '/')
  if (EXEMPT_ROUTES.has(normalized)) return false
  return PROTECTED_SEGMENTS.some((segment) => normalized.startsWith(`${segment}/`) || normalized === `${segment}/route.ts`)
}

function hasServerSideFeatureCheck(source: string): boolean {
  // withRouteContext may carry a generics parameter (withRouteContext<{...}>()),
  // so match the identifier, not the literal call syntax. withCronContext
  // routes are CRON_SECRET-gated system jobs — not user-facing feature
  // surfaces — and count as covered.
  return source.includes('withRouteContext')
    || source.includes('withCronContext')
    || source.includes('requireCompanyFeatureResponse(')
    || source.includes('checkFeatureAccess(')
    || source.includes('featureAccessError(')
}

const findings: Finding[] = []
for (const file of walk(API_ROOT)) {
  if (!routeLooksProtected(file)) continue
  const source = readFileSync(file, 'utf8')
  if (!hasServerSideFeatureCheck(source)) {
    findings.push({ file: relative(process.cwd(), file), reason: 'saknar server-side feature-policy-gate' })
  }
}

if (findings.length > 0) {
  console.error('Feature policy coverage failed:')
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.reason}`)
  process.exit(1)
}

console.log(`Feature policy coverage OK (${walk(API_ROOT).length} route files scanned).`)
