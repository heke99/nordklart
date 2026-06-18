import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { SKATTEVERKET_FLOW_STEPS, taxSubmissionStatusLabel, taxSubmissionTypeLabel } from '@/lib/skatteverket/submissions'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

type TaxSubmission = {
  id: string
  submission_type: string
  period_key: string | null
  status: string
  requires_signature: boolean
  due_date: string | null
  error_message: string | null
}

export default async function SkatteverketPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding')

  const [settingsRes, submissionsRes, deadlinesRes, waitingRes, failedRes] = await Promise.all([
    supabase.from('skatteverket_company_settings').select('connection_status,token_status,requires_signing,default_submitter_email').eq('company_id', companyId).maybeSingle(),
    supabase.from('tax_submissions').select('id,submission_type,period_key,status,requires_signature,due_date,error_message').eq('company_id', companyId).order('updated_at', { ascending: false }).limit(8),
    supabase.from('skatteverket_deadlines').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['open', 'prepared']),
    supabase.from('tax_submissions').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'waiting_for_signature'),
    supabase.from('tax_submissions').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'failed'),
  ])

  const settings = settingsRes.data
  const submissions = (submissionsRes.data ?? []) as TaxSubmission[]
  const connected = settings?.connection_status === 'connected'

  return (
    <NordklartPageShell
      eyebrow="Moms & Skatteverket"
      title="Förbered, skicka och följ signering tydligt"
      description="Nordklart får aldrig låtsas att en deklaration är klar om Skatteverket kräver signering. Statusen visar därför förberedd, skickad, väntar signering, signerad och kvittens separat."
      actions={<Button asChild><Link href="/settings/tax">Koppla Skatteverket</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard label="Koppling" value={connected ? 'Aktiv' : 'Ej kopplad'} description={`Token: ${settings?.token_status ?? 'saknas'}`} tone={connected ? 'success' : 'warning'} />
        <NordklartStatCard label="Väntar signering" value={waitingRes.count ?? 0} description="Kräver åtgärd hos Skatteverket." tone={(waitingRes.count ?? 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Deadlines" value={deadlinesRes.count ?? 0} description="Öppna moms-/skattefrister." />
        <NordklartStatCard label="Fel" value={failedRes.count ?? 0} description="Misslyckade inlämningar." tone={(failedRes.count ?? 0) > 0 ? 'warning' : 'success'} />
      </div>

      <div className="rounded-3xl border bg-card p-5 shadow-sm">
        <h2 className="text-xl font-semibold">Skatteverket-flöde</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-5">
          {SKATTEVERKET_FLOW_STEPS.map((step, index) => (
            <div key={step.key} className="rounded-2xl border bg-background/70 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Steg {index + 1}</div>
              <div className="mt-2 font-semibold">{step.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="rounded-3xl border bg-card p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Senaste ärenden</h2>
          <div className="mt-4 space-y-3">
            {submissions.map((submission) => (
              <div key={submission.id} className="rounded-2xl border bg-background/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="font-medium">{taxSubmissionTypeLabel(submission.submission_type)} · {submission.period_key ?? 'period saknas'}</div>
                  <Badge variant={submission.status === 'failed' ? 'destructive' : submission.status === 'receipt_received' ? 'success' : 'secondary'}>{taxSubmissionStatusLabel(submission.status)}</Badge>
                </div>
                <div className="mt-2 text-sm text-muted-foreground">Signering krävs: {submission.requires_signature ? 'Ja' : 'Nej'} · Deadline: {submission.due_date ?? 'ej satt'}</div>
                {submission.error_message ? <p className="mt-2 text-sm text-destructive">{submission.error_message}</p> : null}
              </div>
            ))}
            {submissions.length === 0 ? <p className="text-sm text-muted-foreground">Inga inlämningar ännu. Skapa momsrapport först.</p> : null}
          </div>
        </section>

        <section className="rounded-3xl border bg-card p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Krav innan sändning</h2>
          <div className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
            <p>1. Momsrapporten ska vara klar och avstämd.</p>
            <p>2. Behörighet och tokenstatus måste vara giltig.</p>
            <p>3. Om signering krävs stannar ärendet på “Väntar signering” tills kvittens finns.</p>
          </div>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="Moms" title="Förbered momsdeklaration" description="Skapa momsunderlag och spara payload/status innan något skickas externt.">
          <Button asChild size="sm" variant="secondary"><Link href="/reports/vat-declaration">Momsrapport</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Koppling" title="Hantera OAuth och tokenstatus" description="Inställningar per bolag styr om Skatteverket-flödet kan användas.">
          <Button asChild size="sm" variant="secondary"><Link href="/settings/tax">Inställningar</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Audit" title="Historik per inlämning" description="tax_submission_events sparar statusbyten, felmeddelanden och kvittensdata.">
          <Button asChild size="sm" variant="secondary"><Link href="/settings/tax">Inställningar</Link></Button>
        </NordklartActionCard>
      </div>
    </NordklartPageShell>
  )
}
