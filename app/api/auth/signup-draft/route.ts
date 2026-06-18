import { randomBytes, createHash } from 'crypto'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { createTemporarySignupPassword } from '@/lib/signup/temporary-password'
import { verifyCompanyLookup } from '@/lib/company-registry/lookup-attestation'
import { createServiceClient } from '@/lib/supabase/server'

const signupDraftSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  loginEmail: z.string().trim().email().max(320),
  workspaceType: z.enum(['company', 'agency']),
  legalForm: z.enum(['enskild_firma', 'aktiebolag']),
  companyName: z.string().trim().min(1).max(200),
  orgNumber: z.string().trim().max(32).optional().or(z.literal('')),
  contactEmail: z.string().trim().email().max(320),
  phone: z.string().trim().max(64).optional().or(z.literal('')),
  addressLine1: z.string().trim().max(200).optional().or(z.literal('')),
  postalCode: z.string().trim().max(20).optional().or(z.literal('')),
  city: z.string().trim().max(100).optional().or(z.literal('')),
  onboardingIntent: z.string().trim().max(64).optional().or(z.literal('')),
  registryLookupToken: z.string().trim().max(12_000).optional().or(z.literal('')),
  acceptedTerms: z.literal(true),
  acceptedPrivacy: z.literal(true),
})

function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown'
}

function appOrigin(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '')
  return configured || request.nextUrl.origin
}

function confirmationRedirectUrl(request: NextRequest): string {
  const url = new URL('/auth/callback', appOrigin(request))
  url.searchParams.set('flow', 'signup')
  url.searchParams.set('next', '/account/set-password?mode=signup')
  return url.toString()
}

function anonymousAuthClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  const body = await request.json().catch(() => null)
  const parsed = signupDraftSchema.safeParse(body)
  const identifier = `${ip}:${parsed.success ? parsed.data.loginEmail.toLowerCase() : 'invalid'}`
  const limit = await checkRateLimit({
    prefix: 'auth:signup-draft',
    identifier,
    maxRequests: 8,
    windowMs: 15 * 60 * 1000,
  })
  if (!limit.ok) return limit.response!

  if (!parsed.success) {
    return NextResponse.json({ error: 'Kontrollera att alla obligatoriska uppgifter är ifyllda.' }, { status: 400 })
  }

  const input = parsed.data
  const orgNumber = input.orgNumber ? normalizeOrgNumber(input.orgNumber) : null
  if (input.legalForm === 'aktiebolag' && !orgNumber) {
    return NextResponse.json({ error: 'Ange ett giltigt organisationsnummer för aktiebolaget.' }, { status: 400 })
  }
  if (input.orgNumber && !orgNumber) {
    return NextResponse.json({ error: 'Organisations- eller personnumret är inte giltigt.' }, { status: 400 })
  }

  const registryLookup = verifyCompanyLookup(input.registryLookupToken)
  if (registryLookup && registryLookup.company.organizationNumber !== orgNumber) {
    return NextResponse.json({ error: 'Bolagsuppslaget matchar inte organisationsnumret.' }, { status: 400 })
  }
  if (registryLookup?.company.registryStatus === 'ceased') {
    return NextResponse.json({ error: 'Det här bolaget är inte aktivt och kan inte registreras automatiskt.' }, { status: 400 })
  }

  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const service = createServiceClient()
  const email = input.loginEmail.toLowerCase()

  const { data: draft, error: draftError } = await service
    .from('signup_drafts')
    .insert({
      token_hash: tokenHash,
      status: 'pending_verification',
      login_email: email,
      first_name: input.firstName,
      last_name: input.lastName,
      workspace_type: input.workspaceType,
      legal_form: input.legalForm,
      company_name: input.companyName,
      org_number: orgNumber,
      contact_email: input.contactEmail.toLowerCase(),
      phone: input.phone || null,
      address_line1: input.addressLine1 || null,
      postal_code: input.postalCode || null,
      city: input.city || null,
      onboarding_intent: input.onboardingIntent || null,
      company_registry_source: registryLookup ? 'bolagsverket' : 'manual',
      company_registry_status: registryLookup?.company.registryStatus === 'active'
        ? 'verified'
        : registryLookup?.company.registryStatus === 'manual_review'
          ? 'manual_review'
          : 'not_requested',
      company_registry_checked_at: registryLookup?.company.retrievedAt ?? null,
      company_registry_payload: registryLookup
        ? {
            company_name: registryLookup.company.companyName,
            legal_form: registryLookup.company.legalForm,
            registry_status: registryLookup.company.registryStatus,
            address: registryLookup.company.address,
            sni_codes: registryLookup.company.sniCodes,
          }
        : {},
      accepted_terms_at: new Date().toISOString(),
      accepted_privacy_at: new Date().toISOString(),
      ip_address: ip === 'unknown' ? null : ip,
      user_agent: request.headers.get('user-agent'),
      expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()

  if (draftError || !draft) {
    console.error('[signup-draft] create failed', draftError)
    return NextResponse.json({ error: 'Kunde inte förbereda registreringen. Försök igen.' }, { status: 500 })
  }

  const { data: authData, error: authError } = await anonymousAuthClient().auth.signUp({
    email,
    password: createTemporarySignupPassword(),
    options: {
      emailRedirectTo: confirmationRedirectUrl(request),
      data: {
        first_name: input.firstName,
        last_name: input.lastName,
        full_name: `${input.firstName} ${input.lastName}`.trim(),
        company_name: input.companyName,
        // The draft is the only commercial source of truth. The user metadata
        // holds just the one-time handoff required by the confirmation callback.
        signup_draft_id: draft.id,
        signup_draft_token: token,
        signup_state: 'pending_email_verification',
        onboarding_intent: null,
        onboarding_flow: null,
        accepted_terms: false,
        accepted_privacy: false,
      },
    },
  })

  const duplicateOrUnconfirmed = authData.user && (authData.user.identities?.length ?? 0) === 0
  const unexpectedSession = Boolean(authData.session)
  if (authError || duplicateOrUnconfirmed || unexpectedSession) {
    await service.from('signup_drafts').update({ status: 'cancelled' }).eq('id', draft.id)
    if (authData.user?.id && !duplicateOrUnconfirmed) {
      await service.auth.admin.deleteUser(authData.user.id).catch(() => undefined)
    }

    return NextResponse.json({
      error: duplicateOrUnconfirmed
        ? 'Det finns redan ett konto med den här e-postadressen. Logga in eller återställ lösenordet.'
        : 'Kunde inte skapa kontot. Försök igen om en stund.',
    }, { status: 400 })
  }

  try {
    const { data: createdUser } = await service.auth.admin.getUserById(authData.user!.id)
    const priorMetadata = createdUser.user?.app_metadata ?? {}
    const { error: metadataError } = await service.auth.admin.updateUserById(authData.user!.id, {
      app_metadata: { ...priorMetadata, has_password: false },
    })
    if (metadataError) throw metadataError
  } catch (error) {
    await service.from('signup_drafts').update({ status: 'cancelled' }).eq('id', draft.id)
    await service.auth.admin.deleteUser(authData.user!.id).catch(() => undefined)
    console.error('[signup-draft] could not prepare password activation', error)
    return NextResponse.json({ error: 'Kunde inte skapa kontot. Försök igen om en stund.' }, { status: 500 })
  }

  try {
    await service.from('auth_audit_events').insert({
      user_id: authData.user?.id ?? null,
      email,
      event_type: 'signup_confirmation_requested',
      status: 'accepted',
      ip_address: ip === 'unknown' ? null : ip,
      user_agent: request.headers.get('user-agent'),
      metadata: { signup_draft_id: draft.id },
    })
  } catch {
    // The confirmation email is already queued. Audit failure must not create a
    // second signup or disclose details to the browser.
  }

  return NextResponse.json({ ok: true })
}
