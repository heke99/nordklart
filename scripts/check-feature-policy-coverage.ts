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

function routeLooksProtected(file: string): boolean {
  const normalized = relative(API_ROOT, file).replaceAll('\\', '/')
  return PROTECTED_SEGMENTS.some((segment) => normalized.startsWith(`${segment}/`) || normalized === `${segment}/route.ts`)
}

function hasServerSideFeatureCheck(source: string): boolean {
  return source.includes('withRouteContext(')
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
