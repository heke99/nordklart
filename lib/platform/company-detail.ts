import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import type { PlatformCompanyOverview } from './company-overview'

export type PlatformCompanyUser = {
  membership_id: string
  company_id: string
  user_id: string
  email: string | null
  full_name: string | null
  role: string
  status: string
  membership_kind: string
  access_source: string
  verification_status: string | null
  joined_at: string | null
  created_at: string
  updated_at: string
  revoked_at: string | null
}

export type PlatformCommercialStatus = {
  company_id: string
  subscription_id: string | null
  subscription_status: string | null
  current_period_end: string | null
  plan_version_id: string | null
  plan_id: string | null
  plan_code: string | null
  plan_name: string | null
  price_excl_vat: number | null
  currency: string | null
  billing_interval: string | null
  active_grant_count: number
  active_grant_types: string[] | null
  active_one_time_count: number
  active_purchase_types: string[] | null
  access_source: string | null
  access_status: string | null
}

export type PlatformOperationalStatus = {
  company_id: string
  onboarding_status: string | null
  bankgiro_status: string | null
  bankgiro_provider_setup_status: string | null
  bankgiro_documents_status: string | null
  active_year_end_access_count: number
  open_review_count: number
  journal_entry_count: number
  last_journal_entry_at: string | null
  unlinked_document_count: number
  pending_inbox_count: number
  unbooked_transaction_count: number
}

export type PlatformPlanVersionOption = {
  id: string
  status: string
  version_number: number
  price_excl_vat: number
  currency: string
  billing_interval: string
  plan: {
    id: string
    code: string
    name: string
    audience_type: string | null
    product: { code: string; product_type: string } | null
  } | null
}

export type PlatformCompanyDetail = {
  company: PlatformCompanyOverview
  users: PlatformCompanyUser[]
  commercial: PlatformCommercialStatus | null
  operational: PlatformOperationalStatus | null
  grants: Array<Record<string, unknown>>
  subscriptions: Array<Record<string, unknown>>
  subscriptionItems: Array<Record<string, unknown>>
  oneTimePurchases: Array<Record<string, unknown>>
  integrityIssues: Array<Record<string, unknown>>
  planVersions: PlatformPlanVersionOption[]
}

export async function getPlatformCompanyDetail(companyId: string): Promise<PlatformCompanyDetail | null> {
  const service = createServiceClient()

  const [
    companyRes,
    usersRes,
    commercialRes,
    operationalRes,
    grantsRes,
    subscriptionsRes,
    itemsRes,
    purchasesRes,
    issuesRes,
    plansRes,
  ] = await Promise.all([
    service.from('platform_company_overview_v').select('*').eq('id', companyId).maybeSingle(),
    service.from('platform_company_user_overview_v').select('*').eq('company_id', companyId).order('created_at', { ascending: false }).limit(100),
    service.from('platform_company_commercial_status_v').select('*').eq('company_id', companyId).maybeSingle(),
    service.from('platform_company_operational_status_v').select('*').eq('company_id', companyId).maybeSingle(),
    service.from('commercial_access_grants').select('id,grant_type,status,starts_at,expires_at,note,granted_by,revoked_at,revoke_reason,created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(20),
    service.from('company_subscriptions').select('id,status,starts_at,current_period_start,current_period_end,trial_ends_at,cancelled_at,external_provider,override_note,plan_version_id,price_snapshot,created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(20),
    service.from('company_subscription_items').select('id,subscription_id,item_type,status,quantity,starts_at,current_period_end,cancelled_at,plan_version_id,price_snapshot,metadata,created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(50),
    service.from('one_time_purchases').select('id,purchase_type,status,fiscal_period_id,price_excl_vat,currency,paid_at,access_starts_at,access_expires_at,permanent_access,metadata,created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(50),
    service.from('bookkeeping_integrity_issues_v').select('source_type,source_id,source_label,source_status,lifecycle_status,issue_message,journal_entry_id,document_id,created_at,updated_at').eq('company_id', companyId).order('created_at', { ascending: true }).limit(50),
    service.from('platform_plan_versions').select('id,status,version_number,price_excl_vat,currency,billing_interval,plan:platform_price_plans(id,code,name,audience_type,product:platform_products(code,product_type))').in('status', ['active', 'scheduled', 'draft']).order('created_at', { ascending: false }).limit(200),
  ])

  if (companyRes.error) throw new Error(companyRes.error.message)
  if (!companyRes.data) return null
  for (const result of [usersRes, commercialRes, operationalRes, grantsRes, subscriptionsRes, itemsRes, purchasesRes, issuesRes, plansRes]) {
    if (result.error) throw new Error(result.error.message)
  }

  return {
    company: companyRes.data as PlatformCompanyOverview,
    users: (usersRes.data ?? []) as PlatformCompanyUser[],
    commercial: (commercialRes.data ?? null) as PlatformCommercialStatus | null,
    operational: (operationalRes.data ?? null) as PlatformOperationalStatus | null,
    grants: (grantsRes.data ?? []) as Array<Record<string, unknown>>,
    subscriptions: (subscriptionsRes.data ?? []) as Array<Record<string, unknown>>,
    subscriptionItems: (itemsRes.data ?? []) as Array<Record<string, unknown>>,
    oneTimePurchases: (purchasesRes.data ?? []) as Array<Record<string, unknown>>,
    integrityIssues: (issuesRes.data ?? []) as Array<Record<string, unknown>>,
    planVersions: normalisePlanVersions(plansRes.data ?? []),
  }
}


function normalisePlanVersions(rows: unknown[]): PlatformPlanVersionOption[] {
  return rows.map((row) => {
    const record = row as Record<string, unknown>
    const rawPlan = Array.isArray(record.plan) ? record.plan[0] : record.plan
    const plan = rawPlan as Record<string, unknown> | null | undefined
    const rawProduct = plan && Array.isArray(plan.product) ? plan.product[0] : plan?.product
    const product = rawProduct as Record<string, unknown> | null | undefined
    return {
      id: String(record.id),
      status: String(record.status),
      version_number: Number(record.version_number ?? 1),
      price_excl_vat: Number(record.price_excl_vat ?? 0),
      currency: String(record.currency ?? 'SEK'),
      billing_interval: String(record.billing_interval ?? 'month'),
      plan: plan ? {
        id: String(plan.id),
        code: String(plan.code),
        name: String(plan.name),
        audience_type: typeof plan.audience_type === 'string' ? plan.audience_type : null,
        product: product ? {
          code: String(product.code),
          product_type: String(product.product_type),
        } : null,
      } : null,
    }
  })
}
