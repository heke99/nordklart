'use client'

import { FormEvent, Suspense, useMemo, useState, type ComponentProps, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft, Building2, Loader2, Mail, UsersRound } from 'lucide-react'
import { BrandWordmark } from '@/components/branding/BrandWordmark'
import { AuthLegalFooter, LegalInlineLinks } from '@/components/auth/AuthLegalFooter'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'
import { flowFromIntent } from '@/lib/onboarding/intents'

type WorkspaceType = 'company' | 'agency'
type LegalForm = 'enskild_firma' | 'aktiebolag'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function strongPassword(value: string) {
  return value.length >= 8
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /\d/.test(value)
    && /[^A-Za-z0-9]/.test(value)
}

export default function RegisterPage() {
  return <Suspense fallback={<div className="min-h-screen" />}><RegisterContent /></Suspense>
}

function RegisterContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()
  const supabase = useMemo(() => createClient(), [])
  const intent = searchParams.get('intent') ?? ''
  const initialWorkspace: WorkspaceType = searchParams.get('workspace') === 'agency' || intent === 'agency' || intent === 'byra'
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
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [acceptedLegal, setAcceptedLegal] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [confirmationEmail, setConfirmationEmail] = useState<string | null>(null)

  const selectedFlow = flowFromIntent(intent)
  const label = workspaceType === 'agency' ? 'redovisningsbyrå' : legalForm === 'aktiebolag' ? 'aktiebolag' : 'enskild firma'

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
    if (!strongPassword(password)) {
      toast({ title: 'Välj ett starkare lösenord', description: 'Använd minst 8 tecken med stor bokstav, liten bokstav, siffra och specialtecken.', variant: 'destructive' })
      return
    }
    if (password !== confirmPassword) {
      toast({ title: 'Lösenorden matchar inte', description: 'Kontrollera att du har skrivit samma lösenord två gånger.', variant: 'destructive' })
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
          onboardingIntent: intent,
          acceptedTerms: true,
          acceptedPrivacy: true,
        }),
      })
      const draft = await draftResponse.json().catch(() => ({})) as { draftId?: string; draftToken?: string; error?: string }
      if (!draftResponse.ok || !draft.draftId || !draft.draftToken) {
        throw new Error(draft.error || 'Kunde inte förbereda registreringen.')
      }

      const { data, error } = await supabase.auth.signUp({
        email: loginEmail.trim().toLowerCase(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?flow=signup&next=/onboarding`,
          data: {
            first_name: firstName.trim(),
            last_name: lastName.trim(),
            full_name: `${firstName} ${lastName}`.trim(),
            company_name: companyName.trim(),
            // The legacy trigger deliberately skips commercial provisioning
            // when these values are absent. The draft is claimed after auth.
            onboarding_intent: null,
            onboarding_flow: null,
            accepted_terms: false,
            accepted_privacy: false,
            signup_draft_id: draft.draftId,
            signup_draft_token: draft.draftToken,
          },
        },
      })
      if (error) throw error
      if (data.user && (data.user.identities?.length ?? 0) === 0 && !data.session) {
        throw new Error('Det finns redan ett konto med den här e-postadressen. Logga in eller återställ lösenordet.')
      }

      if (data.session) {
        const claim = await fetch('/api/auth/signup-draft/claim', { method: 'POST' })
        const result = await claim.json().catch(() => ({})) as { onboardingPath?: string; error?: string }
        if (!claim.ok || !result.onboardingPath) throw new Error(result.error || 'Kunde inte aktivera arbetsytan.')
        router.replace(result.onboardingPath)
        router.refresh()
        return
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
          <p className="mt-3 text-sm leading-6 text-muted-foreground">Vi har skickat en bekräftelselänk till <strong className="text-foreground">{confirmationEmail}</strong>. När länken öppnas skapas din {label}-arbetsyta säkert och du fortsätter till rätt onboarding.</p>
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

        {selectedFlow && workspaceType === 'company' ? <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">Du startar med: <span className="font-medium text-foreground">{selectedFlow === 'bank_automation' ? 'Automatisk bokföring' : selectedFlow === 'year_end_one_time' ? 'Bokslut' : selectedFlow === 'bankgiro_autogiro' ? 'Bankgiro/Autogiro' : 'Bokföring'}</span></div> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Förnamn" value={firstName} onChange={setFirstName} autoComplete="given-name" />
          <Field label="Efternamn" value={lastName} onChange={setLastName} autoComplete="family-name" />
        </div>
        <Field label="E-post för inloggning" value={loginEmail} onChange={setLoginEmail} type="email" autoComplete="email" />
        <Field label={workspaceType === 'agency' ? 'Byrånamn' : 'Företagsnamn'} value={companyName} onChange={setCompanyName} autoComplete="organization" />
        <Field label={legalForm === 'aktiebolag' ? 'Organisationsnummer' : 'Person- eller organisationsnummer'} value={orgNumber} onChange={setOrgNumber} inputMode="numeric" required={legalForm === 'aktiebolag'} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kontakt-e-post för verksamheten" value={contactEmail} onChange={setContactEmail} type="email" />
          <Field label="Telefonnummer" value={phone} onChange={setPhone} type="tel" required={false} />
        </div>
        <Field label="Adress" value={addressLine1} onChange={setAddressLine1} autoComplete="street-address" required={false} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Postnummer" value={postalCode} onChange={setPostalCode} autoComplete="postal-code" required={false} />
          <Field label="Ort" value={city} onChange={setCity} autoComplete="address-level2" required={false} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Lösenord" value={password} onChange={setPassword} type="password" autoComplete="new-password" />
          <Field label="Bekräfta lösenord" value={confirmPassword} onChange={setConfirmPassword} type="password" autoComplete="new-password" />
        </div>
        <label className="flex gap-3 rounded-lg border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
          <input type="checkbox" checked={acceptedLegal} onChange={(event) => setAcceptedLegal(event.target.checked)} required className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
          <span>Jag godkänner Nordklarts <LegalInlineLinks />.</span>
        </label>
        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Skapar konto</> : 'Skapa konto'}
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
