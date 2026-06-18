import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/onboarding/select-path')

const Body = z.object({
  path: z.enum([
    'bookkeeping_direct',
    'bank_automation',
    'year_end_one_time',
    'bankgiro_autogiro',
    'agency_setup',
    'configure_later',
  ]),
})

type StartPath = z.infer<typeof Body>['path']

type StartPathResult = {
  session_id?: string | null
  path?: string | null
  next_href?: string | null
}

const nextHrefForPath = (path: StartPath) => {
  switch (path) {
    case 'bank_automation':
      return '/bank-automation'
    case 'year_end_one_time':
      return '/year-end'
    case 'bankgiro_autogiro':
      return '/payments/bankgiro'
    case 'agency_setup':
      return '/agency'
    default:
      return '/app'
  }
}

function rpcResult(data: unknown): StartPathResult | null {
  const candidate = Array.isArray(data) ? data[0] : data
  if (!candidate || typeof candidate !== 'object') return null

  const row = candidate as StartPathResult
  return typeof row.next_href === 'string' ? row : null
}

async function persistStartPathFallback({
  companyId,
  userId,
  path,
}: {
  companyId: string
  userId: string
  path: StartPath
}) {
  const service = createServiceClient()
  const now = new Date().toISOString()
  const { data: existing, error: existingError } = await service
    .from('onboarding_sessions')
    .select('id, progress_percent, metadata')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .in('status', ['draft', 'in_progress'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingError) return null

  let sessionId: string | null = existing?.id ?? null
  if (sessionId) {
    const metadata = existing?.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? existing.metadata
      : {}
    const { error } = await service
      .from('onboarding_sessions')
      .update({
        path,
        current_step: 'start',
        progress_percent: Math.max(existing?.progress_percent ?? 0, 20),
        metadata: { ...metadata, selected_path_at: now, source: 'dashboard_start_choice_fallback' },
        updated_at: now,
      })
      .eq('id', sessionId)

    if (error) return null
  } else {
    const { data, error } = await service
      .from('onboarding_sessions')
      .insert({
        company_id: companyId,
        user_id: userId,
        path,
        status: 'in_progress',
        current_step: 'start',
        progress_percent: 20,
        metadata: { selected_path_at: now, source: 'dashboard_start_choice_fallback' },
      })
      .select('id')
      .single()

    if (error || !data?.id) return null
    sessionId = data.id
  }

  if (!sessionId) return null

  const { error: choiceError } = await service
    .from('onboarding_choices')
    .upsert({
      session_id: sessionId,
      company_id: companyId,
      choice_key: 'starting_path',
      choice_value: path,
      metadata: { selected_by: userId, source: 'dashboard_start_choice_fallback' },
    }, { onConflict: 'session_id,choice_key' })

  return choiceError ? null : sessionId
}

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error

  const { supabase, user } = auth
  const payload = Body.safeParse(await request.json().catch(() => null))
  if (!payload.success) return NextResponse.json({ error: 'Ogiltigt val.' }, { status: 400 })

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) return NextResponse.json({ error: 'Ingen aktiv arbetsyta.' }, { status: 409 })

  const { data, error } = await supabase.rpc('select_onboarding_start_path', {
    p_company_id: companyId,
    p_path: payload.data.path,
  })
  const result = error ? null : rpcResult(data)

  if (result?.next_href) {
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // The choice is optional and must never block a provisioned workspace. Keep
  // persistence best-effort during a staged database rollout, while logging a
  // server-side signal for investigation.
  const fallbackSessionId = await persistStartPathFallback({
    companyId,
    userId: user.id,
    path: payload.data.path,
  })

  if (error) {
    log.error('select_onboarding_start_path failed', {
      code: error.code,
      reason: error.message,
    })
  }

  return NextResponse.json({
    data: {
      session_id: fallbackSessionId,
      path: payload.data.path,
      next_href: nextHrefForPath(payload.data.path),
      persisted: Boolean(fallbackSessionId),
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
