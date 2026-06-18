export type NordklartOnboardingFlow =
  | 'bookkeeping_direct'
  | 'bank_automation'
  | 'year_end_one_time'
  | 'bankgiro_autogiro'
  | 'agency_setup'

const INTENT_TO_FLOW: Record<string, NordklartOnboardingFlow> = {
  'automated-bookkeeping': 'bank_automation',
  'bank-automation': 'bank_automation',
  auto: 'bank_automation',
  automation: 'bank_automation',
  invoicing: 'bookkeeping_direct',
  bookkeeping: 'bookkeeping_direct',
  start: 'bookkeeping_direct',
  direct: 'bookkeeping_direct',
  'year-end': 'year_end_one_time',
  year_end: 'year_end_one_time',
  bokslut: 'year_end_one_time',
  bankgiro: 'bankgiro_autogiro',
  autogiro: 'bankgiro_autogiro',
  'all-in-one': 'bank_automation',
  agency: 'agency_setup',
  byra: 'agency_setup',
}

export function flowFromIntent(intent?: string | null): NordklartOnboardingFlow | null {
  if (!intent) return null
  return INTENT_TO_FLOW[intent.trim().toLowerCase()] ?? null
}

export function onboardingHrefForIntent(intent?: string | null): string {
  const flow = flowFromIntent(intent)
  return flow ? `/onboarding?flow=${encodeURIComponent(flow)}` : '/onboarding'
}
