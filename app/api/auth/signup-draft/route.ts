import { randomBytes, createHash } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
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
  acceptedTerms: z.literal(true),
  acceptedPrivacy: z.literal(true),
})

function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown'
}

function normalizeOrgNumber(value: string | undefined): string | null {
  const normalized = value?.replace(/[\s-]/g, '') ?? ''
  return normalized || null
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
  if (input.legalForm === 'aktiebolag' && !normalizeOrgNumber(input.orgNumber)) {
    return NextResponse.json({ error: 'Organisationsnummer krävs för aktiebolag.' }, { status: 400 })
  }

  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const service = createServiceClient()

  const { data, error } = await service
    .from('signup_drafts')
    .insert({
      token_hash: tokenHash,
      status: 'pending_verification',
      login_email: input.loginEmail.toLowerCase(),
      first_name: input.firstName,
      last_name: input.lastName,
      workspace_type: input.workspaceType,
      legal_form: input.legalForm,
      company_name: input.companyName,
      org_number: normalizeOrgNumber(input.orgNumber),
      contact_email: input.contactEmail.toLowerCase(),
      phone: input.phone || null,
      address_line1: input.addressLine1 || null,
      postal_code: input.postalCode || null,
      city: input.city || null,
      onboarding_intent: input.onboardingIntent || null,
      accepted_terms_at: new Date().toISOString(),
      accepted_privacy_at: new Date().toISOString(),
      ip_address: ip === 'unknown' ? null : ip,
      user_agent: request.headers.get('user-agent'),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()

  if (error || !data) {
    // eslint-disable-next-line no-console
    console.error('[signup-draft] create failed', error)
    return NextResponse.json({ error: 'Kunde inte förbereda registreringen. Försök igen.' }, { status: 500 })
  }

  return NextResponse.json({ draftId: data.id, draftToken: token })
}
