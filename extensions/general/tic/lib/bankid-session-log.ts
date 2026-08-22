import type { SupabaseClient } from '@supabase/supabase-js'
import type { BankIdProvider } from '@/lib/auth/bankid-provider'
import { hashPersonalNumberHmac, maskPersonalNumber } from '@/lib/auth/bankid'
import type { Logger } from '@/lib/logger'

/**
 * Records the login/signup BankID flow in `bankid_sessions`, the same table the
 * consent and årsredovisning flows already write to.
 *
 * Login orders start before the account is known, so the row is created with
 * `user_id = NULL` (see migration 20260821170000) and claimed once the order
 * completes and the personnummer resolves to an account. Until then RLS makes
 * it invisible to every client role — only the service role that writes it can
 * read it back.
 *
 * Every function here is best-effort by design: the audit row must never be the
 * reason a user cannot log in. Failures are logged, not thrown. The caller
 * passes its own service-role client so this module does not widen the
 * service-role surface.
 */

interface StartArgs {
  supabase: SupabaseClient
  log: Logger
  provider: BankIdProvider
  sessionRef: string
  /** Already truncated to a /24 or /48 — never a full client IP. */
  ipPrefix: string | null
  userAgent: string | null
}

export async function recordBankIdLoginStart(args: StartArgs): Promise<void> {
  const { error } = await args.supabase.from('bankid_sessions').insert({
    user_id: null,
    provider: args.provider.id,
    provider_mode: args.provider.mode,
    provider_session_ref: args.sessionRef,
    purpose: 'auth',
    status: 'pending',
    context: {
      kind: 'login',
      ip_prefix: args.ipPrefix,
      user_agent: args.userAgent?.slice(0, 256) ?? null,
    },
  })
  if (error) {
    args.log.warn('bankid_sessions insert failed for login start (non-blocking)', {
      message: error.message,
      code: error.code,
    })
  }
}

interface SettleArgs {
  supabase: SupabaseClient
  log: Logger
  provider: BankIdProvider
  sessionRef: string
  status: 'pending' | 'complete' | 'failed' | 'cancelled'
  hintCode?: string | null
  user?: { personalNumber: string; name: string } | null
  completedAt?: string | null
}

export async function recordBankIdLoginProgress(args: SettleArgs): Promise<void> {
  // A still-pending order has nothing new worth a write on every 2s poll.
  if (args.status === 'pending') return

  const patch: Record<string, unknown> = {
    status: args.status,
    hint_code: args.hintCode ?? null,
    updated_at: new Date().toISOString(),
  }

  if (args.status === 'complete' && args.user) {
    patch.personal_number_hash = hashPersonalNumberHmac(args.user.personalNumber)
    patch.personal_number_masked = maskPersonalNumber(args.user.personalNumber)
    patch.signer_name = args.user.name
    patch.completed_at = args.completedAt ?? new Date().toISOString()
  }

  const { error } = await args.supabase
    .from('bankid_sessions')
    .update(patch)
    .eq('provider', args.provider.id)
    .eq('provider_session_ref', args.sessionRef)
    // Terminal states are terminal: a late poll must not reopen a settled
    // order or overwrite the identity that settled it.
    .eq('status', 'pending')

  if (error) {
    args.log.warn('bankid_sessions update failed for login progress (non-blocking)', {
      message: error.message,
      code: error.code,
    })
  }
}

/**
 * Attach the resolved account to the order. Called from the completion step,
 * after the provider has confirmed the outcome and the personnummer has been
 * matched (login) or a new account created (signup).
 */
export async function claimBankIdLoginSession(args: {
  supabase: SupabaseClient
  log: Logger
  provider: BankIdProvider
  sessionRef: string
  userId: string
}): Promise<void> {
  const { error } = await args.supabase
    .from('bankid_sessions')
    .update({ user_id: args.userId, updated_at: new Date().toISOString() })
    .eq('provider', args.provider.id)
    .eq('provider_session_ref', args.sessionRef)
    // Never re-point a row that already belongs to someone.
    .is('user_id', null)

  if (error) {
    args.log.warn('bankid_sessions claim failed (non-blocking)', {
      message: error.message,
      code: error.code,
    })
  }
}
