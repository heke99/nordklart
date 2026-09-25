import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isBankIdEnabled } from '@/lib/auth/bankid-enabled'
import { OnboardingBankIdStep } from '@/components/onboarding/OnboardingBankIdStep'

export const dynamic = 'force-dynamic'

/**
 * BankID identification before a company is created (hosted). Reached from
 * the signup claim (428 bankid_required) or from the company wizard.
 */
export default async function OnboardingBankIdPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (!isBankIdEnabled()) redirect('/onboarding')

  const { next } = await searchParams
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-4 py-8">
      <OnboardingBankIdStep next={next === 'companies_new' || next === 'onboarding' ? next : 'signup'} />
    </main>
  )
}
