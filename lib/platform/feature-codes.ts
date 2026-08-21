/**
 * Commercial feature codes and plan codes.
 *
 * Kept free of `server-only` so pure tooling (the feature-policy coverage
 * script, unit tests) can import the constants without a React server
 * runtime. Server modules (`entitlements.ts`, `feature-policy.ts`) re-export
 * everything here, so application code keeps importing from those files.
 */

export const NORDKLART_FEATURES = {
  bookkeepingCore: 'bookkeeping.core',
  invoicingCore: 'invoicing.core',
  reportsCore: 'reports.core',
  onboardingPaths: 'onboarding.paths',
  bankAutomation: 'bank.automation',
  bankProviderModel: 'bank.provider_model',
  bankTransactionIngest: 'bank.transaction_ingest',
  bankMatching: 'bank.matching',
  bankAutobook: 'bank.autobook',
  agencyClients: 'agency.clients',
  agencyDeadlines: 'agency.deadlines',
  agencyReviewQueue: 'agency.review_queue',
  yearEndProjects: 'year_end.projects',
  yearEndIxbrl: 'year_end.ixbrl',
  yearEndProduct: 'year_end.product',
  /**
   * Seeded in `platform_features` and granted by the `year_end_one_time` plan
   * version, so it is a real entitlement — but deliberately NOT used as a gate
   * in application code, and it must not become one.
   *
   * A company-level feature cannot express what this product actually sells:
   * access to one specific fiscal period. Gating on it would let a company that
   * bought year-end for 2024 open 2025. The period-bound check lives in
   * `resolveFiscalPeriodAccess` (lib/year-end/period-access.ts), which reads
   * `one_time_purchases` and honours `fiscal_period_id`, `access_starts_at`,
   * `access_expires_at` and `permanent_access`.
   */
  yearEndOneTimePurchase: 'year_end.one_time_purchase',
  bankgiroOnboarding: 'bankgiro.onboarding',
  bankgiroApplication: 'bankgiro.application',
  bankgiroOperations: 'bankgiro.operations',
  bankgiroProviderModule: 'bankgiro.provider_module',
  apiAccess: 'api.access',
  apiWebhooks: 'api.webhooks',
  webhookDelivery: 'webhooks.delivery',
  companyUsers: 'company.users',
  externalAdvisors: 'external.advisors',
  payrollEmployees: 'payroll.employees',
  salaryRuns: 'salary.runs',
  vatReports: 'vat.reports',
  agencyStaff: 'agency.staff',
  agencyClientPortal: 'agency.client_portal',
  bookkeepingAutomation: 'bookkeeping.automation',
  aiAssistant: 'ai.assistant',
  /**
   * Skatteverket filing flows (moms/AGI validation and submission). Seeded in
   * the DB catalog since 20260626120000 (company_plus/pro, agency_plus/pro)
   * but previously never enforced in application code.
   */
  skatteverketSubmissions: 'skatteverket.submissions',
} as const

export type NordklartFeatureCode = (typeof NORDKLART_FEATURES)[keyof typeof NORDKLART_FEATURES]
export type FeatureCode = NordklartFeatureCode | (string & {})

/**
 * Current sellable catalog codes (source of truth: platform_price_plans /
 * platform_plan_versions in Postgres — this constant exists only for typed
 * references in code and must follow the catalog).
 *
 * Legacy codes (start_monthly, auto_monthly, agency_monthly,
 * bankgiro_addon_monthly) were archived in migration
 * 20260714140000_commercial_catalog_consolidation.
 */
export const NORDKLART_PLAN_CODES = [
  // Company base plans
  'company_start',
  'company_plus',
  'company_pro',
  // Agency base plans
  'agency_start',
  'agency_plus',
  'agency_pro',
  // One-time products
  'year_end_one_time',
  // Add-ons
  'addon_extra_company_user',
  'addon_extra_external_advisor',
  'addon_extra_payroll_5_employees',
  'addon_extra_agency_10_clients',
  'addon_extra_agency_staff',
  'addon_bankgiro_operations',
  'addon_api_webhooks',
  'addon_ai_automation',
] as const

export type NordklartPlanCode = (typeof NORDKLART_PLAN_CODES)[number]
