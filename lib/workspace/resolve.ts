/**
 * Workspace-type resolution for the dashboard shell.
 *
 * Pure module so the rule is unit-testable: the URL always wins over the
 * saved preference. Previously a saved `platform`/`agency` preference forced
 * the platform/agency sidebar even while the user was viewing company pages
 * (`/app`, `/invoices`, …), hiding the entire company navigation.
 */

export type WorkspaceType = 'company' | 'agency' | 'platform'

/**
 * Routes that only exist inside the company workspace. When the user is on
 * one of these, the sidebar must show the company navigation regardless of
 * the saved workspace preference.
 */
const COMPANY_ONLY_PREFIXES = [
  '/app',
  '/transactions',
  '/bookkeeping',
  '/invoices',
  '/supplier-invoices',
  '/suppliers',
  '/customers',
  '/articles',
  '/receipts',
  '/expenses',
  '/assets',
  '/salary',
  '/import',
  '/skatteverket',
  '/skattekonto',
  '/payments',
  '/bank-automation',
  '/automation',
  '/chat',
  '/extensions',
  '/kpi',
] as const

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function resolveWorkspaceType(params: {
  pathname: string
  preferredWorkspaceType: string | null | undefined
  canManagePlatform: boolean
  canManageAgency: boolean
}): WorkspaceType {
  const { pathname, preferredWorkspaceType, canManagePlatform, canManageAgency } = params

  // 1. Explicit workspace URLs always win (guarded by capability).
  if (matchesPrefix(pathname, '/platform')) {
    return canManagePlatform ? 'platform' : 'company'
  }
  if (matchesPrefix(pathname, '/agency')) {
    return canManageAgency ? 'agency' : 'company'
  }

  // 2. Company-only routes force the company workspace so the sidebar always
  //    matches the content on screen.
  if (COMPANY_ONLY_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
    return 'company'
  }

  // 3. Shared routes (/pending, /deadlines, /year-end, /reports, /settings…)
  //    follow the saved preference — agency staff review client companies
  //    through these pages from the agency workspace.
  if (preferredWorkspaceType === 'platform' && canManagePlatform) return 'platform'
  if (preferredWorkspaceType === 'agency' && canManageAgency) return 'agency'
  return 'company'
}
