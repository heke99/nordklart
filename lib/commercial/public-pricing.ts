import 'server-only'

import { createClient } from '@/lib/supabase/server'

export type PublicPricePlan = {
  plan_id: string
  plan_version_id: string
  plan_code: string
  public_name: string
  public_summary: string | null
  public_badge: string | null
  audience_type: 'company' | 'agency'
  company_form_scope: string
  cta_label: string
  cta_href: string
  marketing_metadata: Record<string, unknown>
  currency: string
  monthly_price_ex_vat: number
  billing_interval: string
  price_from_label: string
  features_json: Array<{ code: string; name: string; category: string; limitValue: number | null; limitUnit: string | null }>
  limits_json: Record<string, { value: number | null; unit: string | null }>
  public_sort_order: number
}

function normalizePlan(row: Record<string, unknown>): PublicPricePlan {
  return {
    plan_id: String(row.plan_id),
    plan_version_id: String(row.plan_version_id),
    plan_code: String(row.plan_code),
    public_name: String(row.public_name ?? 'Nordklart'),
    public_summary: typeof row.public_summary === 'string' ? row.public_summary : null,
    public_badge: typeof row.public_badge === 'string' ? row.public_badge : null,
    audience_type: row.audience_type === 'agency' ? 'agency' : 'company',
    company_form_scope: String(row.company_form_scope ?? 'company_all'),
    cta_label: String(row.cta_label ?? 'Kom igång'),
    cta_href: String(row.cta_href ?? '/register'),
    marketing_metadata: typeof row.marketing_metadata === 'object' && row.marketing_metadata !== null ? row.marketing_metadata as Record<string, unknown> : {},
    currency: String(row.currency ?? 'SEK'),
    monthly_price_ex_vat: Number(row.monthly_price_ex_vat ?? 0),
    billing_interval: String(row.billing_interval ?? 'month'),
    price_from_label: String(row.price_from_label ?? 'Pris från'),
    features_json: Array.isArray(row.features_json) ? row.features_json as PublicPricePlan['features_json'] : [],
    limits_json: typeof row.limits_json === 'object' && row.limits_json !== null ? row.limits_json as PublicPricePlan['limits_json'] : {},
    public_sort_order: Number(row.public_sort_order ?? 100),
  }
}

export async function listPublicPricePlans() {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('public_price_plans_v')
    .select('*')
    .order('audience_type', { ascending: true })
    .order('public_sort_order', { ascending: true })

  if (error) {
    console.error('[pricing] public plans unavailable', { code: error.code, message: error.message })
    return []
  }

  return (data ?? []).map((row) => normalizePlan(row as Record<string, unknown>))
}

export function planLimitLabel(plan: PublicPricePlan, code: string, fallback: string) {
  const limit = plan.limits_json?.[code]
  if (!limit) return fallback
  if (limit.value === null || limit.value === undefined) return 'Obegränsat'
  return `${limit.value}${limit.unit ? ` ${limit.unit}` : ''}`
}
