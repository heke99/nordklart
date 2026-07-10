/**
 * Route classification shared by middleware and tests.
 * Keep this module Edge-safe: no Node-only imports.
 */

const PUBLIC_MARKETING_PATHS = new Set([
  '/',
  '/dashboard',
  '/bokforing',
  '/bokslut',
  '/bankgiro',
  '/byra',
  '/priser',
  '/kontakt',
  '/om-oss',
  '/boka-demo',
  '/allmanna-villkor',
  '/prisvillkor',
  '/integritetspolicy',
  '/cookies',
  '/personuppgifter',
  '/privacy',
  '/dpa',
  '/personuppgiftsbitradesavtal',
  '/angerratt',
  '/systemdokumentation',
  '/bokslut/villkor',
])

const PUBLIC_AUTH_PREFIXES = [
  '/login',
  '/forgot-password',
  '/register',
  '/confirm-email',
  '/auth',
  '/sandbox',
]

function normalizePathname(pathname: string): string {
  if (!pathname) return '/'
  if (pathname === '/') return pathname
  return pathname.endsWith('/') ? pathname.replace(/\/+$/, '') || '/' : pathname
}

export function isPublicMarketingPath(pathname: string): boolean {
  return PUBLIC_MARKETING_PATHS.has(normalizePathname(pathname))
}

export function isPublicAuthPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname)
  return PUBLIC_AUTH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  )
}
