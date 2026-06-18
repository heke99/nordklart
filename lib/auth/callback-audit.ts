import { createLogger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'
import type { AuthCallbackFlow, AuthCallbackMethod } from '@/lib/auth/auth-callback'

const log = createLogger('auth/callback-audit')

function getClientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || request.headers.get('x-real-ip') || null
}

export async function recordAuthCallbackAudit(input: {
  request: Request
  flow: AuthCallbackFlow
  method: AuthCallbackMethod
  status: 'success' | 'failed'
  redirectPath: string
  reason?: string
  userId?: string | null
  email?: string | null
  companyId?: string | null
}) {
  try {
    const service = createServiceClient()
    const { error } = await service.from('auth_audit_events').insert({
      user_id: input.userId ?? null,
      company_id: input.companyId ?? null,
      email: input.email?.toLowerCase() ?? null,
      event_type: input.status === 'success' ? 'auth_callback_completed' : 'auth_callback_failed',
      status: input.status,
      ip_address: getClientIp(input.request),
      user_agent: input.request.headers.get('user-agent'),
      metadata: {
        flow: input.flow,
        method: input.method,
        redirect_path: input.redirectPath,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    })

    if (error) {
      log.warn('auth callback audit insert failed', {
        flow: input.flow,
        method: input.method,
        status: input.status,
      })
    }
  } catch {
    // Auth handoff must remain available when the audit store is unavailable.
    log.warn('auth callback audit unavailable', {
      flow: input.flow,
      method: input.method,
      status: input.status,
    })
  }
}
