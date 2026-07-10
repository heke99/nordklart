'use client'

import { FormEvent, Suspense, useEffect, useState, type ComponentProps, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft, Building2, Loader2, Mail, UsersRound } from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { AuthLegalFooter, LegalInlineLinks } from '@/components/auth/AuthLegalFooter'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { flowFromIntent } from '@/lib/onboarding/intents'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { CompanyRegistryLookupStatusLine } from '@/components/company-registry/CompanyRegistryLookupStatus'
import { CompanyRegistryResultCard } from '@/components/company-registry/CompanyRegistryResultCard'
import { useCompanyRegistryLookup } from '@/components/company-registry/useCompanyRegistryLookup'
import { createClient } from '@/lib/supabase/client'
import { clearRecaptIdentity } from '@/lib/recapt'

type WorkspaceType = 'company' | 'agency'
type LegalForm = 'enskild_firma' | 'aktiebolag'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/



export default function RegisterPage() {
  return <Suspense fallback={<div className="min-h-screen" />}><RegisterContent /></Suspense>
}

function RegisterContent() {
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const intent = searchParams.get('intent') ?? ''
  const planCode = searchParams.get('plan') ?? ''
  const planVersionId = searchParams.get('plan_version_id') ?? ''
  const resolvedIntent = intent || (planCode.startsWith('agency_') ? 'agency' : planCode.startsWith('company_') ? 'company' : '')
  const initialWorkspace: WorkspaceType = searchParams.get('workspace') === 'agency' || resolvedIntent === 'agency' || resolvedIntent === 'byra'
    ? 'agency'
    : 'company'
  const legalFromQuery = searchParams.get('legal_form')
  const [workspaceType, setWorkspaceType] = useState<WorkspaceType>(initialWorkspace)
  const [legalForm, setLegalForm] = useState<LegalForm>(legalFromQuery === 'enskild_firma' ? 'enskild_firma' : 'aktiebolag')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [loginEmail, setLoginEmail] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [orgNumber, setOrgNumber] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [addressLine1, setAddressLine1] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [city, setCity] = useState('')
  const [acceptedLegal, setAcceptedLegal] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null)
  const [selectedPlan, setSelectedPlan] = useState<{ name: string; priceLabel: string } | null>(null)
  const [existingSessionEmail, setExistingSessionEmail] = useState<string | null>(null)
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false)
  const [supabase] = useState(() => createClient())
  const registry = useCompanyRegistryLookup({ endpoint: '/api/public/company-lookup' })
  const registryLookupFn = registry.lookup
  const registryCompany = registry.company
  const registryLookup = registryCompany
  const registryLookupToken = registry.lookupToken

  const selectedFlow = flowFromIntent(resolvedIntent || planCode)
  const label = workspaceType === 'agency' ? 'redovisningsbyrå' : legalForm === 'aktiebolag' ? 'aktiebolag' : 'enskild firma'

  useEffect(() => {
    let active = true
    supabase.auth.getUser().then(({ data }) => {
      if (active) setExistingSessionEmail(data.user?.email ?? null)
    })
    return () => {
      active = false
    }
  }, [supabase])

  async function handleSwitchAccount() {
    setIsSwitchingAccount(true)
    clearRecaptIdentity()
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      window.location.replace(`${window.location.pathname}${window.location.search}`)
    }
  }

  useEffect(() => {
    registryLookupFn(orgNumber)
  }, [orgNumber, registryLookupFn])

  // Resolve the plan chosen on /priser so the visitor sees what they picked
  // (name + price) instead of a generic "Vald prisplan" label.
  useEffect(() => {
    if (!planVersionId) return
    let cancelled = false
    fetch(`/api/public/price-plan?plan_version_id=${encodeURIComponent(planVersionId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { data?: { name: string; priceLabel: string } } | null) => {
        if (!cancelled && body?.data) {
          setSelectedPlan({ name: body.data.name, priceLabel: body.data.priceLabel })
        }
      })
      .catch(() => {
        // Silent — the generic label below still renders.
      })
    return () => {
      cancelled = true
    }
  }, [planVersionId])

  useEffect(() => {
    const company = registryCompany
    if (!company) return

    queueMicrotask(() => {
      setCompanyName(company.companyName)
      setAddressLine1(company.address?.street || '')
      setPostalCode(company.address?.postalCode || '')
      setCity(company.address?.city || '')
      if (company.legalForm === 'aktiebolag' || company.legalForm === 'enskild_firma') {
        setLegalForm(company.legalForm)
      }
    })
  }, [registryCompany])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!acceptedLegal) {
      toast({ title: 'Godkänn villkoren', description: 'Du behöver godkänna villkoren och integritetspolicyn.', variant: 'destructive' })
      return
    }
    if (!emailPattern.test(loginEmail) || !emailPattern.test(contactEmail)) {
      toast({ title: 'Kontrollera e-postadresserna', description: 'Fyll i en giltig e-postadress för inloggning och kontakt.', variant: 'destructive' })
      return
    }
    const normalizedOrgNumber = orgNumber ? normalizeOrgNumber(orgNumber) : null
    if (legalForm === 'aktiebolag' && !normalizedOrgNumber) {
      toast({ title: 'Kontrollera organisationsnumret', description: 'Ange ett giltigt organisationsnummer för aktiebolaget.', variant: 'destructive' })
      return
    }
    if (orgNumber && !normalizedOrgNumber) {
      toast({ title: 'Kontrollera organisationsnumret', description: 'Ange ett giltigt organisations- eller personnummer.', variant: 'destructive' })
      return
    }
    if (registryLookup?.registryStatus === 'ceased') {
      toast({ title: 'Bolaget är inte aktivt', description: 'Kontrollera organisationsnumret eller registrera ett aktivt bolag.', variant: 'destructive' })
      return
    }

    setIsLoading(true)
    try {
      const draftResponse = await fetch('/api/auth/signup-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName,
          lastName,
          loginEmail,
          workspaceType,
          legalForm,
          companyName,
          orgNumber,
          contactEmail,
          phone,
          addressLine1,
          postalCode,
          city,
          onboardingIntent: resolvedIntent || planCode,
          selectedPlanVersionId: planVersionId || undefined,
          selectedPlanCode: planCode || undefined,
          registryLookupToken: registryLookupToken ?? '',
          acceptedTerms: true,
          acceptedPrivacy: true,
        }),
      })
      const draft = await draftResponse.json().catch(() => ({})) as { ok?: boolean; error?: string }
      if (!draftResponse.ok || !draft.ok) {
        throw new Error(draft.error || 'Kunde inte förbereda registreringen.')
      }

      setConfirmationEmail(loginEmail.trim().toLowerCase())
    } catch (error) {
      toast({
        title: 'Kontot kunde inte skapas',
        description: error instanceof Error ? error.message : 'Försök igen om en stund.',
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  if (confirmationEmail) {
    return (
      <AuthShell>
        <div className="rounded-xl border bg-card p-6 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Mail className="h-6 w-6" /></div>
          <h1 className="mt-5 text-2xl font-semibold">Bekräfta din e-postadress</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">Vi har skickat en bekräftelselänk till <strong className="text-foreground">{confirmationEmail}</strong>. När du öppnar länken bekräftar du först din e-postadress och väljer sedan ett lösenord. Du kan därefter logga in från den dator där du vill fortsätta med din {label}-arbetsyta.</p>
          <Button className="mt-6 w-full" variant="secondary" asChild><Link href="/login"><ArrowLeft className="mr-2 h-4 w-4" />Till inloggning</Link></Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <div className="mb-7 text-center">
        <BrandWordmark size="hero" className="mb-2" />
        <p className="mt-3 text-sm text-muted-foreground">Skapa rätt arbetsyta från början. Du kan alltid lägga till fler bolag senare.</p>
      </div>
      {existingSessionEmail ? (
        <div className="mb-5 rounded-xl border border-primary/25 bg-primary/5 p-4 shadow-sm" role="status">
          <p className="text-sm font-medium text-foreground">Du är redan inloggad som {existingSessionEmail}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Fortsätt till din befintliga arbetsyta eller byt konto innan du registrerar ett nytt konto.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Button type="button" onClick={() => window.location.assign('/app')}>Fortsätt till appen</Button>
            <Button type="button" variant="outline" onClick={handleSwitchAccount} disabled={isSwitchingAccount}>
              {isSwitchingAccount ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Byt konto
            </Button>
          </div>
        </div>
      ) : null}
      <form onSubmit={handleSubmit} className="space-y-5 rounded-xl border bg-card p-6 shadow-sm">
        <section className="space-y-3">
          <Label>Jag vill använda Nordklart som</Label>
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceCard active={workspaceType === 'company'} onClick={() => setWorkspaceType('company')} icon={<Building2 className="h-5 w-5" />} title="Företag" description="Bokföring för min egen verksamhet." />
            <ChoiceCard active={workspaceType === 'agency'} onClick={() => setWorkspaceType('agency')} icon={<UsersRound className="h-5 w-5" />} title="Redovisningsbyrå" description="Flera kundbolag, team och granskning." />
          </div>
        </section>

        <section className="space-y-3">
          <Label>{workspaceType === 'agency' ? 'Byråns juridiska form' : 'Företagsform'}</Label>
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceCard active={legalForm === 'enskild_firma'} onClick={() => setLegalForm('enskild_firma')} title="Enskild firma" description="För egen verksamhet." />
            <ChoiceCard active={legalForm === 'aktiebolag'} onClick={() => setLegalForm('aktiebolag')} title="Aktiebolag" description="För verksamhet med organisationsnummer." />
          </div>
        </section>

        {selectedPlan ? (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
            Vald plan: <span className="font-medium text-foreground">{selectedPlan.name}</span>
            <span className="ml-1">({selectedPlan.priceLabel} exkl. moms)</span>
            <span className="ml-1">Planvalet sparas till betalningssteget — inget dras förrän du bekräftar betalningen.</span>
          </div>
        ) : (selectedFlow || planCode) && workspaceType === 'company' ? <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">Du startar med: <span className="font-medium text-foreground">{selectedFlow === 'bank_automation' ? 'Automatisk bokföring' : selectedFlow === 'year_end_one_time' ? 'Bokslut' : selectedFlow === 'bankgiro_autogiro' ? 'Bankgiro/Autogiro' : planCode ? 'Vald prisplan' : 'Bokföring'}</span>{planVersionId ? <span className="ml-1">Planvalet sparas till betalningssteget.</span> : null}</div> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Förnamn" value={firstName} onChange={setFirstName} autoComplete="given-name" />
          <Field label="Efternamn" value={lastName} onChange={setLastName} autoComplete="family-name" />
        </div>
        <Field label="E-post för inloggning" value={loginEmail} onChange={setLoginEmail} type="email" autoComplete="email" />

        <section className="space-y-3 rounded-lg border bg-muted/10 p-4">
          <div className="space-y-1">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Företagsuppgifter</h2>
            <p className="text-xs text-muted-foreground">Skriv organisationsnumret först. Nordklart hämtar bolagsnamn, adress och SNI från Bolagsverket när uppgifter finns.</p>
          </div>
          <Field label={legalForm === 'aktiebolag' ? 'Organisationsnummer' : 'Person- eller organisationsnummer'} value={orgNumber} onChange={setOrgNumber} inputMode="numeric" required={legalForm === 'aktiebolag'} />
          <CompanyRegistryLookupStatusLine status={registry.status} message={registry.message} />
          <CompanyRegistryResultCard company={registryLookup} />
          <Field label={workspaceType === 'agency' ? 'Byrånamn' : 'Företagsnamn'} value={companyName} onChange={setCompanyName} autoComplete="organization" />
          <Field label="Adress" value={addressLine1} onChange={setAddressLine1} autoComplete="street-address" required={false} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Postnummer" value={postalCode} onChange={setPostalCode} autoComplete="postal-code" required={false} />
            <Field label="Ort" value={city} onChange={setCity} autoComplete="address-level2" required={false} />
          </div>
        </section>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kontakt-e-post för verksamheten" value={contactEmail} onChange={setContactEmail} type="email" />
          <Field label="Telefonnummer" value={phone} onChange={setPhone} type="tel" required={false} />
        </div>
        <label className="flex gap-3 rounded-lg border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
          <input type="checkbox" checked={acceptedLegal} onChange={(event) => setAcceptedLegal(event.target.checked)} required className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
          <span>Jag godkänner Nordklarts <LegalInlineLinks />.</span>
        </label>
        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Skickar bekräftelse</> : 'Fortsätt'}
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-muted-foreground">Har du redan konto? <Link href="/login" className="font-medium text-foreground underline underline-offset-2">Logga in</Link></p>
      <AuthLegalFooter className="mt-6" />
    </AuthShell>
  )
}

function AuthShell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-gradient-to-b from-background to-primary/[0.03] px-4 py-10"><div className="mx-auto w-full max-w-2xl">{children}</div></div>
}

function ChoiceCard({ active, onClick, icon, title, description }: { active: boolean; onClick: () => void; icon?: ReactNode; title: string; description: string }) {
  return <button type="button" onClick={onClick} className={`rounded-xl border p-4 text-left transition ${active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/40'}`}>
    {icon ? <span className="mb-3 block text-primary">{icon}</span> : null}
    <span className="block font-medium">{title}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
  </button>
}

function Field({ label, value, onChange, type = 'text', required = true, ...props }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean } & Omit<ComponentProps<typeof Input>, 'value' | 'onChange' | 'type' | 'required'>) {
  const id = label.toLowerCase().replace(/[^a-zåäö0-9]+/gi, '-')
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Input id={id} value={value} onChange={(event) => onChange(event.target.value)} type={type} required={required} disabled={false} className="h-11" {...props} /></div>
}
