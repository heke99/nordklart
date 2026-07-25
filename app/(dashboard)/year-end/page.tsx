import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { checkFeatureAccess, NORDKLART_FEATURES } from '@/lib/platform/entitlements'
import { YEAR_END_PRODUCT_STEPS, exportPackageLabel, yearEndStatusLabel } from '@/lib/year-end/product'
import { NordklartActionCard, NordklartPageShell, NordklartStatCard } from '@/components/nordklart/NordklartShell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export const dynamic = 'force-dynamic'

type YearEndProject = {
  id: string
  status: string
  source: string | null
  readiness_score: number | null
  export_package_status: string | null
  next_action: string | null
  updated_at: string
}

export default async function YearEndProductPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) redirect('/onboarding?intent=year-end')

  const [featureAccess, projectsRes, checksRes, purchasesRes, deliverablesRes] = await Promise.all([
    checkFeatureAccess(supabase, companyId, NORDKLART_FEATURES.yearEndProjects),
    supabase.from('year_end_projects').select('id,status,source,readiness_score,export_package_status,next_action,updated_at').eq('company_id', companyId).order('updated_at', { ascending: false }).limit(6),
    supabase.from('year_end_checks').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['warning', 'error']),
    supabase
      .from('one_time_purchases')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('purchase_type', 'year_end')
      .in('status', ['paid', 'active', 'fulfilled'])
      .or('access_starts_at.is.null,access_starts_at.lte.now')
      .or('permanent_access.eq.true,access_expires_at.is.null,access_expires_at.gt.now'),
    supabase.from('year_end_deliverables').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['generated', 'approved', 'sent', 'archived']),
  ])

  // A period-bound one-time purchase is intentionally not a company-wide
  // feature row. It still activates the product entry point for that buyer.
  const hasYearEnd = featureAccess.allowed || (purchasesRes.count ?? 0) > 0
  const featureResolutionFailed = (
    featureAccess.reason === 'database_error'
    || Boolean(purchasesRes.error)
  ) && !hasYearEnd
  const projects = (projectsRes.data ?? []) as YearEndProject[]

  return (
    <NordklartPageShell
      eyebrow="Bokslut"
      title="Bokslut från SIE eller befintlig bokföring"
      description="Starta bokslut från SIE eller befintlig bokföring, gå igenom kontroller, skapa justeringar och bygg ett exportpaket med tydlig historik."
      actions={<Button asChild><Link href="/bookkeeping/year-end">Starta bokslut</Link></Button>}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <NordklartStatCard
          label="Tillgång"
          value={featureResolutionFailed ? 'Kunde inte verifieras' : hasYearEnd ? 'Aktiv' : 'Ej aktiv'}
          description={featureResolutionFailed ? 'Ingen planändring krävs. Försök igen om en stund.' : 'Ingår i plan eller separat bokslutsköp.'}
          tone={hasYearEnd ? 'success' : 'warning'}
        />
        <NordklartStatCard label="Projekt" value={projects.length} description="Senaste bokslutsprojekt." />
        <NordklartStatCard label="Avvikelser" value={checksRes.count ?? 0} description="Kräver kontroll innan låsning." tone={(checksRes.count ?? 0) > 0 ? 'warning' : 'success'} />
        <NordklartStatCard label="Exportpaket" value={deliverablesRes.count ?? 0} description="Redo att lämnas vidare." tone="primary" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-3xl border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Aktuella bokslut</h2>
              <p className="mt-1 text-sm text-muted-foreground">Samma flöde används för abonnemang och engångsköp.</p>
            </div>
            <Badge variant={(purchasesRes.count ?? 0) > 0 ? 'success' : 'secondary'}>{purchasesRes.count ?? 0} engångsköp</Badge>
          </div>
          <div className="mt-4 space-y-3">
            {projects.map((project) => (
              <div key={project.id} className="rounded-2xl border bg-background/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="font-medium">{yearEndStatusLabel(project.status)}</div>
                  <Badge variant={project.status === 'completed' || project.status === 'locked' ? 'success' : 'secondary'}>{project.source === 'sie_import' ? 'SIE-import' : project.source === 'existing_bookkeeping' ? 'Befintlig bokföring' : 'Bokslut'}</Badge>
                </div>
                <div className="mt-2 text-sm text-muted-foreground">Kontrollstatus: {project.readiness_score ?? 'saknas'}% · Exportpaket: {exportPackageLabel(project.export_package_status)}</div>
                <div className="mt-1 text-xs text-muted-foreground">Nästa steg: {project.next_action ?? 'kör kontroller'}</div>
              </div>
            ))}
            {projects.length === 0 ? <p className="text-sm text-muted-foreground">Inga bokslutsprojekt ännu. Starta med SIE-import eller befintlig bokföring.</p> : null}
          </div>
        </section>

        <section className="rounded-3xl border bg-card p-5 shadow-sm">
          <h2 className="text-xl font-semibold">Flöde</h2>
          <ol className="mt-4 space-y-3">
            {YEAR_END_PRODUCT_STEPS.map((step, index) => (
              <li key={step.key} className="flex gap-3 rounded-2xl border bg-background/70 p-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">{index + 1}</span>
                <span>
                  <span className="block font-semibold">{step.label}</span>
                  <span className="text-sm text-muted-foreground">{step.description}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <NordklartActionCard meta="SIE" title="Starta från SIE" description="Engångsköp kan börja med SIE-import och sedan köra samma bokslutskontroller som abonnemangskunder.">
          <Button asChild size="sm" variant="secondary"><Link href="/import?mode=sie">Importera SIE</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Rapportpaket" title="Bygg exportpaket" description="Resultat, balans, bokslutsbilagor och underlag ska skapas från låst och spårbar data.">
          <Button asChild size="sm" variant="secondary"><Link href="/reports">Visa rapporter</Link></Button>
        </NordklartActionCard>
        <NordklartActionCard meta="Bokslutsköp" title="Bokslut utan månadsabonnemang" description="Kunden kan köpa bokslut separat och ändå få samma kontroller, rapporter och exportpaket.">
          <Button asChild size="sm" variant="secondary"><Link href="/settings/billing">Hantera plan</Link></Button>
        </NordklartActionCard>
      </div>
    </NordklartPageShell>
  )
}
