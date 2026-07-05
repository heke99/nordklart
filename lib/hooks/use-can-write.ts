'use client'

import { useCompany } from '@/contexts/CompanyContext'

/**
 * Returns whether the current user can perform write actions in the
 * active company.
 *
 * The value is resolved server-side in the dashboard layout via
 * `resolve_company_access` (the same source of truth as the API layer and
 * RLS), so agency reviewers/read-only staff and `active_limited`
 * memberships are correctly treated as read-only even when their legacy
 * role maps to `member`.
 *
 * Used by every write-action button (create / edit / delete / send /
 * approve / etc.) across the dashboard to render the button in a
 * disabled state with a lock icon and tooltip.
 *
 * This is the UI layer of write enforcement. The API layer
 * (`requireWritePermission()`) and RLS remain the security-critical
 * backstops — this hook only controls what the user sees and can click.
 */
export function useCanWrite(): { canWrite: boolean } {
  const { canWrite } = useCompany()
  return { canWrite }
}
