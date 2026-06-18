import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { createServiceClient } from '@/lib/supabase/server'

function getIp(request: NextRequest) {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown'
  )
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { email?: string }
  const email = body.email?.trim().toLowerCase()
  const ip = getIp(request)

  const limited = await checkRateLimit({
    prefix: 'auth:resend-confirmation',
    identifier: `${ip}:${email ?? 'missing'}`,
    maxRequests: 3,
    windowMs: 15 * 60 * 1000,
  })

  if (!limited.ok) return limited.response!

  // Always return the same response. Do not disclose whether an address has
  // an account or whether that account is already confirmed.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ ok: true })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } },
  )

  const redirectTo = `${new URL(request.url).origin}/auth/callback?flow=signup&next=/onboarding`
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: redirectTo },
  })

  try {
    await createServiceClient().from('auth_audit_events').insert({
      email,
      event_type: error ? 'signup_confirmation_resend_failed' : 'signup_confirmation_resent',
      status: error ? 'failed' : 'accepted',
      ip_address: ip === 'unknown' ? null : ip,
      user_agent: request.headers.get('user-agent'),
      metadata: { flow: 'signup' },
    })
  } catch {
    // A neutral auth response must not depend on audit availability.
  }

  return NextResponse.json({ ok: true })
}
