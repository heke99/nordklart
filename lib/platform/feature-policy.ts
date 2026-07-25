import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { checkFeatureAccess, featureAccessError, type FeatureCode } from '@/lib/platform/entitlements'

// The operation → feature mapping lives in feature-policy-map.ts (no
// server-only import) so the CI coverage script and unit tests evaluate the
// exact production mapping. Application code keeps importing from this file.
export {
  featureForOperation,
  featureForApiV1Operation,
  isPeriodBoundYearEndOperation,
  isCoreOperation,
  isPlatformOperation,
  isApiV1CoreOperation,
  CORE_OPERATION_PREFIXES,
  PLATFORM_OPERATION_PREFIXES,
  API_V1_CORE_OPERATIONS,
} from '@/lib/platform/feature-policy-map'

/** Returns a canonical 403 response when a legacy route is not yet wrapped. */
export async function requireCompanyFeatureResponse(
  supabase: SupabaseClient,
  companyId: string,
  featureCode: FeatureCode,
): Promise<Response | null> {
  const access = await checkFeatureAccess(supabase, companyId, featureCode)
  return access.allowed ? null : featureAccessError(featureCode, access.reason)
}
