import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

export default async function BillingSettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  const { data: subscription } = await supabase
    .from('company_subscriptions')
    .select('status, plan_id')
    .eq('company_id', companyId)
    .in('status', ['trialing', 'active'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: plan } = subscription?.plan_id
    ? await supabase
        .from('platform_price_plans')
        .select('name, description')
        .eq('id', subscription.plan_id)
        .maybeSingle()
    : { data: null }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="rounded-[1.75rem] border bg-card p-6 shadow-sm md:p-8">
        <p className="text-sm font-medium text-primary">Plan och tjänster</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Hantera Nordklart för ditt företag</h1>
        <p className="mt-3 text-muted-foreground">Lägg till tjänster när verksamheten behöver dem. Bokföringen påverkas inte av att en valfri modul saknas.</p>
        <div className="mt-6 rounded-2xl border bg-background/70 p-5">
          <p className="text-sm text-muted-foreground">Aktiv plan</p>
          <p className="mt-1 text-lg font-semibold">{plan?.name ?? 'Ingen plan vald ännu'}</p>
          <p className="mt-1 text-sm text-muted-foreground">{plan?.description ?? 'Välj plan eller kontakta administratören för att aktivera fler tjänster.'}</p>
          <p className="mt-3 text-sm font-medium">Status: {subscription?.status === 'trialing' ? 'Testperiod' : subscription?.status === 'active' ? 'Aktiv' : 'Inte aktiverad'}</p>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild><Link href="/payments/bankgiro">Bankgiro och Autogiro</Link></Button>
          <Button asChild variant="secondary"><Link href="/year-end">Bokslut</Link></Button>
        </div>
      </section>
    </div>
  )
}
