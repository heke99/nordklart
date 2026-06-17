import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkFeatureAccess } from '@/lib/platform/entitlements'

export async function canUseYearEnd(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId?: string | null,
): Promise<boolean> {
  const entitlement = await checkFeatureAccess(supabase, companyId, 'year_end.projects')
  if (entitlement.allowed) return true

  if (!fiscalPeriodId) return false

  const { data } = await supabase
    .from('one_time_purchases')
    .select('id, status, access_expires_at, permanent_access')
    .eq('company_id', companyId)
    .eq('purchase_type', 'year_end')
    .eq('fiscal_period_id', fiscalPeriodId)
    .in('status', ['paid', 'active', 'fulfilled'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const row = data as { permanent_access?: boolean; access_expires_at?: string | null } | null
  if (!row) return false
  if (row.permanent_access) return true
  if (!row.access_expires_at) return true
  return new Date(row.access_expires_at).getTime() >= Date.now()
}
