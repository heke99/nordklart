import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/onboarding/complete-core')

type CompletionResult = {
  company_id?: string | null
  dashboard_href?: string | null
}

function rpcResult(data: unknown): CompletionResult | null {
  const candidate = Array.isArray(data) ? data[0] : data
  if (!candidate || typeof candidate !== 'object') return null

  const row = candidate as CompletionResult
  return typeof row.dashboard_href === 'string' ? row : null
}

async function persistCompletionFallback({
  companyId,
  userId,
}: {
  companyId: string
  userId: string
}): Promise<boolean> {
  const service = createServiceClient()
  const now = new Date().toISOString()

  const { data: settings, error: settingsLookupError } = await service
    .from('company_settings')
    .select('onboarding_step')
    .eq('company_id', companyId)
    .maybeSingle()

  if (settingsLookupError || !settings) return false

  const { error: settingsError } = await service
    .from('company_settings')
    .update({
      onboarding_complete: true,
      onboarding_step: Math.max(settings.onboarding_step ?? 1, 5),
      updated_at: now,
    })
    .eq('company_id', companyId)

  if (settingsError) return false

  const { data: sessions, error: sessionsError } = await service
    .from('onboarding_sessions')
    .select('id')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .in('status', ['draft', 'in_progress'])

  if (sessionsError) return false

  const sessionIds = (sessions ?? []).map((session) => session.id)
  if (sessionIds.length === 0) return true

  const { error: stepsError } = await service
    .from('onboarding_steps')
    .update({
      status: 'skipped',
      completed_at: now,
      updated_at: now,
    })
    .in('session_id', sessionIds)
    .neq('status', 'completed')

  if (stepsError) return false

  const { error: completionError } = await service
    .from('onboarding_sessions')
    .update({
      status: 'completed',
      current_step: 'dashboard',
      progress_percent: 100,
      completed_at: now,
      updated_at: now,
    })
    .in('id', sessionIds)

  if (completionError) return false

  const { error: choicesError } = await service
    .from('onboarding_choices')
    .upsert(
      sessionIds.map((sessionId) => ({
        session_id: sessionId,
        company_id: companyId,
        choice_key: 'core_workspace_ready',
        choice_value: 'true',
        metadata: { completed_by: userId, source: 'complete_core_onboarding_fallback' },
      })),
      { onConflict: 'session_id,choice_key' },
    )

  return !choicesError
}

export async function POST() {
  const auth = await requireAuth()
  if (auth.error) return auth.error

  const { supabase, user } = auth
  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) return NextResponse.json({ error: 'Ingen aktiv arbetsyta.' }, { status: 409 })

  const { data, error } = await supabase.rpc('complete_core_onboarding', {
    p_company_id: companyId,
  })
  const result = !error ? rpcResult(data) : null

  if (result) {
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // The accounting workspace is already provisioned before this optional
  // completion step. Do not strand a user on onboarding if a staged database
  // rollout has not exposed the RPC yet; persist the state best-effort and
  // continue to the dashboard.
  const persisted = await persistCompletionFallback({ companyId, userId: user.id })
  if (error) {
    log.error('complete_core_onboarding failed', {
      code: error.code,
      reason: error.message,
    })
  }

  return NextResponse.json({
    data: {
      company_id: companyId,
      dashboard_href: '/app',
      persisted,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
