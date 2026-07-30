/**
 * Feature-policy coverage check (CI: `npm run check:feature-policy`).
 *
 * Two layers of protection:
 *
 * 1. Segment coverage — every route file under a monetized path segment must
 *    use one of the shared gate helpers (withRouteContext / withCronContext /
 *    withApiV1 / requireCompanyFeatureResponse / checkFeatureAccess /
 *    requirePlatformRole). A raw handler in a paid segment fails the build.
 *
 * 2. Operation mapping — every operation string passed to withRouteContext /
 *    withApiV1 is resolved through the REAL production mapping
 *    (lib/platform/feature-policy-map.ts). An operation that resolves to
 *    `null` fails the build unless it is:
 *      - a documented core operation (CORE_OPERATION_PREFIXES /
 *        API_V1_CORE_OPERATIONS),
 *      - a platform operation (and the file enforces a platform role),
 *      - a period-bound year-end operation (and the file calls
 *        requireYearEndAccess / requireYearEndReportAccess), or
 *      - listed in NON_COMMERCIAL_OPERATIONS below with a reason.
 *
 *    This is what guarantees "a monetized route cannot ship without a real
 *    feature behind it" — using withRouteContext alone is NOT enough.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  featureForOperation,
  featureForApiV1Operation,
  isApiV1CoreOperation,
  isCoreOperation,
  isPeriodBoundYearEndOperation,
  isPlatformOperation,
  isSieImportOperation,
} from '../lib/platform/feature-policy-map'

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
  'transactions',
  'reconciliation',
  'import',
  'salary',
  'bankid',
  'agency',
  'customers',
  'articles',
  'suppliers',
  'supplier-invoices',
]

function walk(dir: string): string[] {
  const entries = readdirSync(dir)
  return entries.flatMap((entry) => {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) return entry === '__tests__' ? [] : walk(path)
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
  // Agency management endpoints: gated on agency membership + capacity limits
  // (resolveManageableAgency / agency plan limits), not on a company-scoped
  // commercial feature — the caller acts in agency context, not company
  // context.
  'agency/create/route.ts',
  'agency/staff/invite/route.ts',
  'agency/clients/route.ts',
  // Reference-data lookups without company data (Skatteverket open data /
  // global payroll constants). Auth-only; the salary surfaces that consume
  // them are feature-gated on salary.runs.
  'salary/payroll-config/[year]/route.ts',
  'salary/tax-tables/lookup/route.ts',
  'salary/tax-tables/status/route.ts',
])

// Dashboard operations (withRouteContext) that resolve to `null` in
// featureForOperation and are accepted anyway. Every entry needs a reason.
const NON_COMMERCIAL_OPERATIONS = new Map<string, string>([
  // (currently empty — core/platform/year-end operations are recognised
  // structurally via feature-policy-map.ts)
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
    || source.includes('withApiV1')
    || source.includes('requireCompanyFeatureResponse(')
    || source.includes('checkFeatureAccess(')
    || source.includes('featureAccessError(')
    || source.includes('requirePlatformRole(')
    || source.includes('requirePlatformAdmin(')
    || source.includes('resolveFiscalPeriodAccess(')
}

function hasPeriodBoundYearEndCheck(source: string): boolean {
  return source.includes('requireYearEndAccess')
    || source.includes('requireYearEndReportAccess')
}

const OPERATION_PATTERNS = [
  /withRouteContext(?:<[^>]*>)?\(\s*'([^']+)'/g,
  /withRouteContext(?:<[\s\S]*?>)?\(\s*\n\s*'([^']+)'/g,
]
const V1_OPERATION_PATTERNS = [
  /withApiV1(?:<[^>]*>)?\(\s*'([^']+)'/g,
  /withApiV1(?:<[\s\S]*?>)?\(\s*\n\s*'([^']+)'/g,
]

function extractOperations(source: string, patterns: RegExp[]): string[] {
  const operations = new Set<string>()
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
      operations.add(match[1])
    }
  }
  return [...operations]
}

const findings: Finding[] = []
const allRoutes = walk(API_ROOT)
let scannedOperations = 0

for (const file of allRoutes) {
  const relFile = relative(process.cwd(), file)
  const source = readFileSync(file, 'utf8')

  // Layer 1 — segment coverage.
  if (routeLooksProtected(file) && !hasServerSideFeatureCheck(source)) {
    findings.push({ file: relFile, reason: 'saknar server-side feature-policy-gate' })
  }

  // Layer 2 — operation mapping (dashboard wrapper).
  for (const operation of extractOperations(source, OPERATION_PATTERNS)) {
    scannedOperations += 1
    const feature = featureForOperation(operation)
    if (feature) continue

    if (isPlatformOperation(operation)) {
      if (!source.includes('requirePlatformRole') && !source.includes('requirePlatformAdmin')) {
        findings.push({
          file: relFile,
          reason: `operation '${operation}' är platform-scoped men routen saknar requirePlatformRole()/requirePlatformAdmin()`,
        })
      }
      continue
    }

    if (isPeriodBoundYearEndOperation(operation)) {
      if (!hasPeriodBoundYearEndCheck(source)) {
        findings.push({
          file: relFile,
          reason: `operation '${operation}' är period-bunden year-end men routen saknar requireYearEndAccess()/requireYearEndReportAccess()`,
        })
      }
      continue
    }

    if (isSieImportOperation(operation)) {
      if (!source.includes("accessPolicy: 'sie_import'")) {
        findings.push({
          file: relFile,
          reason: `operation '${operation}' måste använda accessPolicy: 'sie_import' för bokförings- eller periodbundet engångsbokslut`,
        })
      }
      continue
    }

    if (isCoreOperation(operation)) continue
    if (NON_COMMERCIAL_OPERATIONS.has(operation)) continue

    findings.push({
      file: relFile,
      reason: `operation '${operation}' mappar inte till någon feature i featureForOperation() — lägg till mapping eller dokumenterat undantag`,
    })
  }

  // Layer 2 — operation mapping (v1 API wrapper).
  for (const operation of extractOperations(source, V1_OPERATION_PATTERNS)) {
    scannedOperations += 1
    const feature = featureForApiV1Operation(operation)
    if (feature) continue
    if (isApiV1CoreOperation(operation)) continue

    // Period-bound year-end v1 routes must additionally enforce the
    // period-specific access check in the handler.
    if (isPeriodBoundYearEndOperation(operation)) {
      if (!hasPeriodBoundYearEndCheck(source)) {
        findings.push({
          file: relFile,
          reason: `v1-operation '${operation}' är period-bunden year-end men routen saknar requireYearEndAccess()/requireYearEndReportAccess()`,
        })
      }
      continue
    }

    findings.push({
      file: relFile,
      reason: `v1-operation '${operation}' mappar inte till någon feature i featureForApiV1Operation() — lägg till mapping eller dokumenterat undantag`,
    })
  }
}

if (findings.length > 0) {
  console.error('Feature policy coverage failed:')
  for (const finding of findings) console.error(`- ${finding.file}: ${finding.reason}`)
  process.exit(1)
}

console.log(`Feature policy coverage OK (${allRoutes.length} route files, ${scannedOperations} operations scanned).`)
