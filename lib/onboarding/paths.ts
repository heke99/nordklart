import { Building2, Landmark, ReceiptText, Route, WalletCards } from 'lucide-react'

export type OnboardingPathCode =
  | 'bookkeeping_direct'
  | 'bank_automation'
  | 'year_end_one_time'
  | 'bankgiro_autogiro'
  | 'agency_setup'

export type OnboardingPath = {
  code: OnboardingPathCode
  title: string
  shortTitle: string
  description: string
  steps: string[]
  href: string
  featureCode?: string
  icon: typeof Route
}

export const ONBOARDING_PATHS: OnboardingPath[] = [
  {
    code: 'bookkeeping_direct',
    title: 'Bokföring direkt',
    shortTitle: 'Bokföring',
    description: 'Skapa bolag, räkenskapsår och momsperiod utan Bankgiro-friktion.',
    steps: ['Bolagsuppgifter', 'Räkenskapsår', 'Momsperiod', 'Prisplan', 'Dashboard'],
    href: '/onboarding?flow=bookkeeping_direct',
    featureCode: 'bookkeeping.core',
    icon: ReceiptText,
  },
  {
    code: 'bank_automation',
    title: 'Automatisk bokföring',
    shortTitle: 'Auto',
    description: 'Koppla bank, importera transaktioner och låt regelmotorn föreslå bokföring.',
    steps: ['Skapa bolag', 'Koppla bank', 'Importera transaktioner', 'Regler', 'Granska'],
    href: '/onboarding?flow=bank_automation',
    featureCode: 'bank.automation',
    icon: Landmark,
  },
  {
    code: 'year_end_one_time',
    title: 'Bokslut engångsköp',
    shortTitle: 'Bokslut',
    description: 'Starta bokslut från SIE eller befintlig bokföring och betala per räkenskapsår.',
    steps: ['SIE-import', 'Räkenskapsår', 'Kontroller', 'Engångsköp', 'Exportpaket'],
    href: '/onboarding?flow=year_end_one_time',
    featureCode: 'year_end.projects',
    icon: Route,
  },
  {
    code: 'agency_setup',
    title: 'Redovisningsbyrå',
    shortTitle: 'Byrå',
    description: 'Skapa byråns egen arbetsyta, bjud in teamet och lägg till kundbolag när du är redo.',
    steps: ['Byråuppgifter', 'Team', 'Första kundbolaget', 'Byråöversikt'],
    href: '/register?workspace=agency',
    featureCode: 'agency.clients',
    icon: Building2,
  },
  {
    code: 'bankgiro_autogiro',
    title: 'Bankgiro/Autogiro',
    shortTitle: 'Bankgiro',
    description: 'Separat ansökan med bolagsfrågor, verklig huvudman, volym, dokument och review.',
    steps: ['Bolagsuppgifter', 'Ägare', 'Volym', 'Dokument', 'Review', 'Provider setup'],
    href: '/onboarding?flow=bankgiro_autogiro',
    featureCode: 'bankgiro.onboarding',
    icon: WalletCards,
  },
]

export function getOnboardingPath(code: string | null | undefined) {
  return ONBOARDING_PATHS.find((path) => path.code === code) ?? null
}
