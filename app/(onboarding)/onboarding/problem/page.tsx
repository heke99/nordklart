import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertTriangle, Home, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RetryWorkspaceProvisioningButton } from '@/components/onboarding/RetryWorkspaceProvisioningButton'
import { createClient, createServiceClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function WorkspaceProvisioningProblemPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const service = createServiceClient()
  const { data: draft } = await service
    .from('signup_drafts')
    .select('status, provision_reference, provision_error_category')
    .eq('claimed_by_user_id', user.id)
    .in('status', ['ready_for_first_login', 'provisioning', 'failed'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!draft) redirect('/app')

  const pending = draft.status === 'provisioning'

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.16),transparent_34%),hsl(var(--background))] px-5 py-10">
      <section className="mx-auto max-w-lg rounded-[2rem] border bg-card p-7 shadow-sm md:p-9">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-700">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <p className="mt-5 text-sm font-medium text-primary">Kontot är aktivt</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Arbetsytan blev inte klar</h1>
        <p className="mt-3 leading-7 text-muted-foreground">
          Din e-postadress och ditt lösenord fungerar. Vi kunde däremot inte slutföra installationen av din arbetsyta ännu. Du kan försöka igen utan att skapa ett nytt konto.
        </p>

        {draft.provision_reference ? (
          <div className="mt-6 rounded-2xl border bg-muted/30 p-4 text-sm">
            <div className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4 text-primary" /> Ärende</div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{draft.provision_reference}</p>
          </div>
        ) : null}

        <div className="mt-7">
          {pending ? (
            <p className="rounded-xl border bg-muted/30 p-4 text-sm text-muted-foreground">
              Installationen pågår redan. Vänta ett ögonblick och ladda sedan om sidan.
            </p>
          ) : <RetryWorkspaceProvisioningButton />}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Button asChild variant="secondary"><Link href="/login">Till inloggning</Link></Button>
          <Button asChild variant="ghost"><Link href="/"><Home className="mr-2 h-4 w-4" />Till startsidan</Link></Button>
        </div>
      </section>
    </main>
  )
}
