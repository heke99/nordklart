import { createServiceClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/account/delete')

ensureInitialized()

const DeleteAccountSchema = z.object({
  confirm_email: z.string().email(),
})

/**
 * POST /api/account/delete
 *
 * Anonymizes the calling user's account. The auth.users row is retained
 * (banned for ~100 years) as a tombstone so FKs into BFL-retained
 * bookkeeping data (companies.created_by, audit_log.user_id, etc.) stay
 * valid. Memberships are removed, profile PII is stripped, and a global
 * signout forces all sessions to end.
 *
 * Precondition: the user must own zero non-archived companies. The RPC
 * enforces this at the DB level and raises SQLSTATE P0001 with a message
 * if the precondition fails — we return 409 in that case.
 */
export async function POST(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error

  const { supabase, user } = auth

  const result = await validateBody(request, DeleteAccountSchema)
  if (!result.success) return result.response
  const { confirm_email } = result.data

  if (!user.email || confirm_email.trim().toLowerCase() !== user.email.toLowerCase()) {
    return NextResponse.json(
      { error: 'E-postadressen stämmer inte överens med ditt konto.' },
      { status: 400 }
    )
  }

  // Anonymize in the DB. Runs as SECURITY DEFINER and checks auth.uid()
  // internally, so we don't need service role here.
  const { error: rpcError } = await supabase.rpc('anonymize_user_account', {
    target_user_id: user.id,
  })

  if (rpcError) {
    // P0001 = precondition violation from our RPC: user still owns active
    // companies. Re-fetch the blockers and return 409 so the UI can show
    // the list inline.
    if (rpcError.code === 'P0001') {
      const service = createServiceClient()
      const { data: blockers } = await service
        .from('company_members')
        .select('company_id, companies!inner(id, name, archived_at)')
        .eq('user_id', user.id)
        .eq('role', 'owner')
        .eq('status', 'active')
        .is('companies.archived_at', null)

      const list = (blockers ?? []).map((b) => {
        const company = (b.companies as unknown) as { id: string; name: string }
        return { id: company.id, name: company.name }
      })

      return NextResponse.json(
        {
          error: 'Du måste radera eller överlåta dina företag innan du kan radera kontot.',
          blockers: list,
        },
        { status: 409 }
      )
    }

    log.error('anonymize_user_account failed', { userId: user.id, error: rpcError.message })
    return NextResponse.json(
      { error: 'Kunde inte radera kontot. Försök igen.' },
      { status: 500 }
    )
  }

  // Wipe PII in auth.users metadata and ban the tombstone row ~100 years.
  // DB functions can't reach supabase.auth.admin, so we do it here.
  //
  // Note: auth.users.email is intentionally NOT scrubbed. The original
  // address is retained as a legitimate-interest tombstone so that:
  //   (1) re-signup with the same email is blocked by Supabase's unique
  //       constraint — deletion must feel permanent, not trivially
  //       reversible by re-registering
  //   (2) support can verify identity when a former user asks to recover
  //       BFL-retained räkenskapsinformation
  // This must be documented in the privacy policy under legitimate
  // interest (GDPR Art. 6(1)(f)). The email is never read by the app
  // after this point — login is impossible (row is banned) and the
  // profile is anonymized, so no UI ever surfaces it.
  //
  // user_metadata / app_metadata ARE wiped — they may contain display
  // name, avatar, or provider info that isn't needed for recovery.
  // GoTrue MERGES metadata on update, so `{}` would change nothing: every
  // existing key is set to null, which removes it. Admin calls report
  // failure through `{ error }` rather than throwing, so each one is checked.
  const service = createServiceClient()
  const { data: existing, error: fetchError } = await service.auth.admin.getUserById(user.id)
  if (fetchError) log.error('Failed to read user before anonymizing auth metadata', { userId: user.id })
  const nulled = (meta: Record<string, unknown> | undefined) =>
    Object.fromEntries(Object.keys(meta ?? {}).map((key) => [key, null]))
  const { error: banError } = await service.auth.admin.updateUserById(user.id, {
    user_metadata: nulled(existing?.user?.user_metadata),
    app_metadata: { ...nulled(existing?.user?.app_metadata), anonymized: true },
    ban_duration: '876000h',
  })
  if (banError) {
    log.error('Failed to wipe metadata and ban anonymized user', { userId: user.id, code: banError.code })
  }

  // End every session server-side. auth.admin.signOut() expects a JWT, not a
  // user id, so it never did this.
  const { error: sessionError } = await service.rpc('revoke_user_sessions', { p_user_id: user.id })
  if (sessionError) log.error('Failed to revoke sessions of anonymized user', { userId: user.id })

  // Credentials and personal data that anonymize_user_account does not own.
  const cleanup = await Promise.all([
    service.from('api_keys').update({ revoked_at: new Date().toISOString(), refresh_token_hash: null })
      .eq('user_id', user.id).is('revoked_at', null),
    service.from('oauth_client_registrations').update({ revoked_at: new Date().toISOString() })
      .eq('user_id', user.id).is('revoked_at', null),
    service.from('bankid_identities').delete().eq('user_id', user.id),
    service.from('calendar_feeds').delete().eq('user_id', user.id),
    service.from('push_subscriptions').delete().eq('user_id', user.id),
  ])
  for (const result of cleanup) {
    if (result.error) log.error('Account cleanup step failed', { userId: user.id, code: result.error.code })
  }

  if (banError) {
    // The account must not remain able to log in; tell the user to retry
    // rather than reporting success.
    return NextResponse.json({ error: 'Kontot anonymiserades men kunde inte spärras. Försök igen.' }, { status: 500 })
  }

  const deletedAt = new Date().toISOString()
  await eventBus.emit({
    type: 'account.deleted',
    payload: { userId: user.id, deletedAt },
  })

  // Best-effort: clear the caller's session cookie too.
  await supabase.auth.signOut().catch(() => {})

  // Request body is consumed; avoid unused-var lint.
  void request

  return NextResponse.json({ success: true })
}
