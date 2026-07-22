/**
 * Central, feature-aware navigation builder.
 *
 * Pure module (no server-only, no React) so the dashboard sidebar, tests and
 * future surfaces (command palette, mobile nav) derive the SAME structure:
 * which items exist per workspace, which are locked behind a commercial
 * feature, and which require an active company.
 *
 * Product decision: locked features stay VISIBLE but render in a locked
 * state with an upgrade CTA (link to /settings/billing) — users should
 * discover what the product offers, never a dead button.
 */

import { NORDKLART_FEATURES } from '@/lib/platform/feature-codes'

export type NavIconKey =
  | 'home'
  | 'pending'
  | 'transactions'
  | 'bookkeeping'
  | 'invoices'
  | 'suppliers'
  | 'reports'
  | 'skatteverket'
  | 'yearEnd'
  | 'bankgiro'
  | 'extensions'
  | 'automation'
  | 'assistant'
  | 'agency'
  | 'platform'
  | 'settings'
  | 'users'
  | 'pricePlans'
  | 'onboarding'
  | 'bank'
  | 'api'
  | 'operations'

export interface NavItemSpec {
  href: string
  label: string
  icon: NavIconKey
  badge?: number
  requiresCompany?: boolean
  /** Commercial feature the item depends on (informational). */
  feature?: string
  /** True when the company lacks the feature — render locked + upgrade CTA. */
  locked?: boolean
}

export interface NavGroupSpec {
  label: string
  items: NavItemSpec[]
}

export interface NavBuilderInput {
  workspaceType: 'company' | 'agency' | 'platform'
  hasCompany: boolean
  canManageAgency: boolean
  canManagePlatform: boolean
  /**
   * Enabled feature codes for the active company, or null when entitlements
   * could not be resolved. Null fails OPEN for display purposes only — the
   * server-side feature policy still enforces real access on every API call.
   */
  enabledFeatures: ReadonlySet<string> | null
  /**
   * Year-end is special: a fiscal-period-bound one-time purchase grants
   * access without the company-wide feature. True when EITHER source exists.
   */
  hasYearEndAccess?: boolean
  /** Sandbox companies see everything unlocked — the demo must be explorable. */
  isSandbox?: boolean
  badges?: {
    pendingOperations?: number
    uncategorizedTransactions?: number
  }
}

function lockState(
  input: NavBuilderInput,
  feature: string,
  override?: boolean,
): { feature: string; locked: boolean } {
  if (input.isSandbox) return { feature, locked: false }
  if (override === true) return { feature, locked: false }
  if (!input.enabledFeatures) return { feature, locked: false }
  return { feature, locked: !input.enabledFeatures.has(feature) }
}

export function buildNavGroups(input: NavBuilderInput): NavGroupSpec[] {
  const { workspaceType, canManageAgency, canManagePlatform, badges } = input

  if (workspaceType === 'platform') {
    return [
      {
        label: 'Plattform',
        items: [
          { href: '/platform', label: 'Översikt', icon: 'home' },
          { href: '/platform/price-plans', label: 'Prisplaner', icon: 'pricePlans' },
          { href: '/platform/onboarding', label: 'Onboarding', icon: 'onboarding' },
          { href: '/platform/bank-automation', label: 'Bankautomation', icon: 'bank' },
          { href: '/platform/year-end', label: 'Bokslut', icon: 'yearEnd' },
          { href: '/platform/skatteverket', label: 'Skatteverket', icon: 'skatteverket' },
          { href: '/platform/bankgiro', label: 'Bankgiro', icon: 'bankgiro' },
          { href: '/platform/api-webhooks', label: 'API & webhooks', icon: 'api' },
          { href: '/platform/integrations', label: 'Integrationer', icon: 'extensions' },
          { href: '/platform/company-operations', label: 'Företagsoperationer', icon: 'operations' },
        ],
      },
    ]
  }

  if (workspaceType === 'agency') {
    return [
      {
        label: 'Byrå',
        items: [
          { href: '/agency', label: 'Byråöversikt', icon: 'home' },
          { href: '/agency/clients', label: 'Kunder', icon: 'users' },
          { href: '/pending', label: 'Att granska', icon: 'pending', badge: badges?.pendingOperations, requiresCompany: true },
          { href: '/deadlines', label: 'Deadlines', icon: 'yearEnd', requiresCompany: true },
          { href: '/year-end', label: 'Bokslut', icon: 'yearEnd', requiresCompany: true },
          { href: '/reports', label: 'Rapporter', icon: 'reports', requiresCompany: true },
        ],
      },
      {
        label: 'Inställningar',
        items: [
          { href: '/settings/team', label: 'Team', icon: 'users', requiresCompany: true },
          { href: '/settings', label: 'Inställningar', icon: 'settings' },
        ],
      },
    ]
  }

  return [
    {
      label: 'Arbetsyta',
      items: [
        { href: '/app', label: 'Översikt', icon: 'home', requiresCompany: true },
        { href: '/pending', label: 'Att göra', icon: 'pending', badge: badges?.pendingOperations, requiresCompany: true },
        {
          href: '/transactions', label: 'Bank & transaktioner', icon: 'transactions',
          badge: badges?.uncategorizedTransactions, requiresCompany: true,
          ...lockState(input, NORDKLART_FEATURES.bookkeepingCore),
        },
        {
          href: '/bookkeeping', label: 'Bokföring', icon: 'bookkeeping', requiresCompany: true,
          ...lockState(input, NORDKLART_FEATURES.bookkeepingCore),
        },
        {
          href: '/invoices', label: 'Fakturor', icon: 'invoices', requiresCompany: true,
          ...lockState(input, NORDKLART_FEATURES.invoicingCore),
        },
        {
          href: '/supplier-invoices', label: 'Leverantörer', icon: 'suppliers', requiresCompany: true,
          ...lockState(input, NORDKLART_FEATURES.bookkeepingCore),
        },
      ],
    },
    {
      label: 'Ekonomi',
      items: [
        {
          href: '/reports', label: 'Rapporter', icon: 'reports', requiresCompany: true,
          ...lockState(input, NORDKLART_FEATURES.reportsCore),
        },
        {
          href: '/skatteverket', label: 'Moms & skatt', icon: 'skatteverket', requiresCompany: true,
          ...lockState(input, NORDKLART_FEATURES.skatteverketSubmissions),
        },
        {
          href: '/year-end', label: 'Bokslut', icon: 'yearEnd', requiresCompany: true,
          ...lockState(input, NORDKLART_FEATURES.yearEndProjects, input.hasYearEndAccess),
        },
        {
          href: '/payments/bankgiro', label: 'Bankgiro', icon: 'bankgiro', requiresCompany: true,
          ...lockState(input, NORDKLART_FEATURES.bankgiroApplication),
        },
        { href: '/extensions', label: 'Integrationer', icon: 'extensions', requiresCompany: true },
      ],
    },
    {
      label: 'Inställningar',
      items: [
        {
          href: '/automation', label: 'Automatisering', icon: 'automation', requiresCompany: true,
          ...lockState(input, NORDKLART_FEATURES.bookkeepingAutomation),
        },
        {
          href: '/chat', label: 'Bokföringsassistent', icon: 'assistant', requiresCompany: true,
          ...lockState(input, NORDKLART_FEATURES.aiAssistant),
        },
        ...(canManageAgency ? [{ href: '/agency', label: 'Redovisningsbyrå', icon: 'agency' } satisfies NavItemSpec] : []),
        ...(canManagePlatform ? [{ href: '/platform', label: 'Plattform', icon: 'platform' } satisfies NavItemSpec] : []),
        { href: '/settings', label: 'Inställningar', icon: 'settings' },
      ],
    },
  ]
}
