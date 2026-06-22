import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Clock, Building2, MailCheck } from 'lucide-react'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getBranding } from '@/lib/branding/service'

export default async function AccessPendingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const service = createServiceClient()
  const { data: requests } = await service
    .from('company_access_requests')
    .select('id, status, requested_role, created_at, companies:company_id(name, org_number)')
    .eq('requester_user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(5)

  const pending = (requests ?? []).find((request) => request.status === 'pending')
  const latest = pending ?? requests?.[0] ?? null
  const company = latest?.companies as { name?: string | null; org_number?: string | null } | null

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <div className="text-center">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-secondary">
            <Clock className="h-6 w-6 text-primary" />
          </div>
          <p className="text-sm font-medium text-muted-foreground">{getBranding().appName.toLowerCase()}</p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">Väntar på godkännande</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Du är inloggad, men du har inte aktiv åtkomst till bolaget ännu. En ägare eller administratör behöver godkänna din begäran.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4" />
              {company?.name || 'Bolag'}
            </CardTitle>
            <CardDescription>
              {company?.org_number ? `Organisationsnummer: ${company.org_number}` : 'Åtkomstbegäran har registrerats.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            {latest?.status === 'pending' ? (
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                <div className="flex items-start gap-3">
                  <MailCheck className="mt-0.5 h-4 w-4 text-primary" />
                  <div>
                    <p className="font-medium text-foreground">Begäran är skickad</p>
                    <p className="mt-1">När en behörig person godkänner dig får du tillgång nästa gång du öppnar Nordklart.</p>
                  </div>
                </div>
              </div>
            ) : latest?.status === 'rejected' ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive">
                Din begäran blev nekad. Kontakta bolagets administratör om du anser att detta är fel.
              </div>
            ) : (
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                Ingen aktiv åtkomstbegäran hittades. Du kan logga ut och be en administratör bjuda in dig.
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button asChild className="flex-1">
                <Link href="/app">Försök öppna dashboard</Link>
              </Button>
              <Button asChild variant="outline" className="flex-1">
                <Link href="/login">Till inloggning</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
