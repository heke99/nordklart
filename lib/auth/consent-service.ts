import type { SupabaseClient } from '@supabase/supabase-js'
import { getBankIdProvider } from '@/lib/auth/bankid-provider'
import { hashPersonalNumberHmac, maskPersonalNumber } from '@/lib/auth/bankid'
import { markSignatureSigned } from '@/lib/bokslut/arsredovisning/signature-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('consent-service')

/**
 * BankID consent-signing service.
 *
 * Flow:
 *   1. startConsentSigning() — creates a bankid_sessions row + starts the
 *      provider sign session. The exact consent text is stored verbatim.
 *   2. pollConsentSession() — collects provider status; on completion the
 *      signed_consents row (immutable, DB-enforced) is created BEFORE the
 *      session is marked complete, so a "complete" session always has its
 *      consent evidence. Replays are idempotent (unique consent per
 *      session), and legacy complete-without-consent sessions self-heal.
 *   3. cancelConsentSession() — user-initiated cancel of a pending session.
 *   4. revokeConsent() — status flip + audit (the row itself is immutable).
 *
 * Personnummer is never stored in plaintext: keyed hash (HMAC-SHA256 with a
 * server secret) + masked display value only.
 */

export type ConsentType =
  | 'agency_data_sharing'
  | 'bank_connection'
  | 'skatteverket'
  | 'invoice_financing'
  | 'api_integration'
  | 'bankgiro_autogiro'
  | 'arsredovisning_signature'
  | 'other'

export const CONSENT_TYPE_LABELS_SV: Record<ConsentType, string> = {
  agency_data_sharing: 'Delning av bokföringsdata med redovisningsbyrå',
  bank_connection: 'Bankkoppling (PSD2)',
  skatteverket: 'Skatteverket-flöden',
  invoice_financing: 'Fakturafinansiering',
  api_integration: 'API/integrationer',
  bankgiro_autogiro: 'Bankgiro/Autogiro-ansökan',
  arsredovisning_signature: 'Underskrift av årsredovisning',
  other: 'Övrigt samtycke',
}

export interface StartConsentArgs {
  companyId: string
  userId: string
  consentType: ConsentType
  title: string
  consentText: string
  endUserIp: string
  userAgent?: string
  /** Flow context, e.g. { kind: 'arsredovisning_signature', signature_request_id } */
  context?: Record<string, unknown>
}

export interface StartConsentResult {
  sessionId: string
  autoStartToken: string | null
  qrStartToken: string | null
  qrStartSecret: string | null
  provider: string
  providerMode: string
}

export async function startConsentSigning(
  supabase: SupabaseClient,
  args: StartConsentArgs,
): Promise<StartConsentResult> {
  const provider = getBankIdProvider()
  const started = await provider.startSign({
    endUserIp: args.endUserIp,
    userAgent: args.userAgent,
    userVisibleText: args.consentText,
  })

  const { data: session, error } = await supabase
    .from('bankid_sessions')
    .insert({
      user_id: args.userId,
      company_id: args.companyId,
      provider: provider.id,
      provider_mode: provider.mode,
      provider_session_ref: started.sessionRef,
      purpose: 'consent',
      sign_text: args.consentText,
      context: {
        consent_type: args.consentType,
        title: args.title,
        ...(args.context ?? {}),
      },
      status: 'pending',
    })
    .select('id')
    .single()

  if (error || !session) {
    // Session row failed — cancel the provider session so it can't dangle.
    await provider.cancel(started.sessionRef).catch(() => {})
    throw new Error(`Kunde inte starta signeringen: ${error?.message ?? 'okänt fel'}`)
  }

  const sessionId = (session as { id: string }).id

  // Audit: signing started (security-relevant lifecycle event).
  await supabase.from('audit_log').insert({
    user_id: args.userId,
    company_id: args.companyId,
    action: 'SECURITY_EVENT',
    table_name: 'bankid_sessions',
    record_id: sessionId,
    actor_id: args.userId,
    description: `BankID-signering startad: ${args.title} (${args.consentType})`,
    new_state: { consent_type: args.consentType, provider: provider.id, provider_mode: provider.mode },
  }).then(({ error: auditError }) => {
    if (auditError) log.warn('audit insert failed for consent start', { sessionId, error: auditError.message })
  })

  return {
    sessionId,
    autoStartToken: started.autoStartToken,
    qrStartToken: started.qrStartToken,
    qrStartSecret: started.qrStartSecret,
    provider: provider.id,
    providerMode: provider.mode,
  }
}

export interface PollConsentResult {
  status: 'pending' | 'complete' | 'failed' | 'cancelled'
  hintCode: string | null
  consentId: string | null
  qrStartToken?: string | null
  qrStartSecret?: string | null
}

export async function pollConsentSession(
  supabase: SupabaseClient,
  args: { sessionId: string; userId: string },
): Promise<PollConsentResult> {
  const { data: session, error } = await supabase
    .from('bankid_sessions')
    .select('*')
    .eq('id', args.sessionId)
    .eq('user_id', args.userId)
    .maybeSingle()

  if (error || !session) {
    throw new Error('Signeringssessionen kunde inte hittas.')
  }

  const row = session as {
    id: string
    company_id: string | null
    user_id: string
    provider_session_ref: string
    status: string
    sign_text: string | null
    context: Record<string, unknown>
  }

  // Already terminal — idempotent poll. A complete session must ALWAYS have
  // its consent evidence: if the row predates the atomic ordering (or a
  // legacy failure left it orphaned) we self-heal by recreating the consent
  // from the identity fields persisted on the session itself.
  if (row.status === 'complete') {
    const { data: consent } = await supabase
      .from('signed_consents')
      .select('id')
      .eq('bankid_session_id', row.id)
      .maybeSingle()
    const existingId = (consent as { id: string } | null)?.id ?? null
    if (existingId) {
      return { status: 'complete', hintCode: null, consentId: existingId }
    }

    const legacy = row as unknown as {
      personal_number_hash: string | null
      personal_number_masked: string | null
      signer_name: string | null
      completed_at: string | null
    }
    const healed = await createConsentForSession(supabase, row, {
      pnHash: legacy.personal_number_hash,
      pnMasked: legacy.personal_number_masked,
      signerName: legacy.signer_name,
      completedAt: legacy.completed_at ?? new Date().toISOString(),
    })
    log.warn('self-healed missing consent for completed BankID session', { sessionId: row.id, consentId: healed })
    return { status: 'complete', hintCode: null, consentId: healed }
  }
  if (row.status === 'failed' || row.status === 'cancelled') {
    return { status: row.status as 'failed' | 'cancelled', hintCode: null, consentId: null }
  }

  const provider = getBankIdProvider()
  const collected = await provider.collect(row.provider_session_ref)

  if (collected.status === 'pending') {
    return {
      status: 'pending',
      hintCode: collected.hintCode,
      consentId: null,
      qrStartToken: collected.qrStartToken ?? null,
      qrStartSecret: collected.qrStartSecret ?? null,
    }
  }

  if (collected.status === 'failed' || collected.status === 'cancelled') {
    await supabase
      .from('bankid_sessions')
      .update({ status: collected.status, hint_code: collected.hintCode, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    await supabase.from('audit_log').insert({
      user_id: row.user_id,
      company_id: row.company_id,
      action: 'SECURITY_EVENT',
      table_name: 'bankid_sessions',
      record_id: row.id,
      actor_id: row.user_id,
      description: `BankID-signering ${collected.status === 'failed' ? 'misslyckades' : 'avbröts'} (${collected.hintCode ?? 'okänd orsak'})`,
      new_state: { status: collected.status, hint_code: collected.hintCode },
    })
    return { status: collected.status, hintCode: collected.hintCode, consentId: null }
  }

  // Complete: create the consent evidence FIRST, then mark the session
  // complete. If the session update fails, the next poll finds the existing
  // consent (unique per session) and finishes the transition — the system
  // can never show "complete" without a consent id.
  const pn = collected.user?.personalNumber ?? ''
  const pnHash = pn ? hashPersonalNumberHmac(pn) : null
  const pnMasked = pn ? maskPersonalNumber(pn) : null
  const signerName = collected.user?.name ?? null
  const completedAt = collected.completedAt ?? new Date().toISOString()

  const consentId = await createConsentForSession(supabase, row, { pnHash, pnMasked, signerName, completedAt })

  await supabase
    .from('bankid_sessions')
    .update({
      status: 'complete',
      personal_number_hash: pnHash,
      personal_number_masked: pnMasked,
      signer_name: signerName,
      completed_at: completedAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)

  return { status: 'complete', hintCode: null, consentId }
}

/**
 * Create (or reuse) the signed consent for a session, write the audit row and
 * run flow side effects. Idempotent per session: an existing consent row for
 * the session is returned as-is (protects against poll replays between the
 * consent insert and the session status flip).
 */
async function createConsentForSession(
  supabase: SupabaseClient,
  row: {
    id: string
    company_id: string | null
    user_id: string
    sign_text: string | null
    context: Record<string, unknown>
  },
  identity: {
    pnHash: string | null
    pnMasked: string | null
    signerName: string | null
    completedAt: string
  },
): Promise<string> {
  const context = row.context ?? {}
  const consentType = (context.consent_type as ConsentType | undefined) ?? 'other'
  const title = (context.title as string | undefined)
    ?? CONSENT_TYPE_LABELS_SV[consentType]

  const { data: consent, error: consentErr } = await supabase
    .from('signed_consents')
    .insert({
      company_id: row.company_id,
      user_id: row.user_id,
      consent_type: consentType,
      title,
      consent_text: row.sign_text ?? '',
      signed_via: 'bankid',
      bankid_session_id: row.id,
      personal_number_hash: identity.pnHash,
      personal_number_masked: identity.pnMasked,
      signer_name: identity.signerName,
      status: 'active',
      context,
    })
    .select('id')
    .single()

  if (consentErr || !consent) {
    // Unique violation on bankid_session_id → a concurrent poll already
    // created the consent. Reuse it instead of failing.
    if ((consentErr as { code?: string } | null)?.code === '23505') {
      const { data: existing } = await supabase
        .from('signed_consents')
        .select('id')
        .eq('bankid_session_id', row.id)
        .maybeSingle()
      const existingId = (existing as { id: string } | null)?.id
      if (existingId) return existingId
    }
    log.error('signed_consents insert failed for BankID session', consentErr ?? undefined, {
      sessionId: row.id,
    })
    throw new Error('Signeringen slutfördes men samtycket kunde inte sparas. Försök igen.')
  }

  const consentId = (consent as { id: string }).id

  // Audit trail (login/signing events are security-relevant).
  await supabase.from('audit_log').insert({
    user_id: row.user_id,
    company_id: row.company_id,
    action: 'SECURITY_EVENT',
    table_name: 'signed_consents',
    record_id: consentId,
    actor_id: row.user_id,
    description: `BankID-signerat samtycke: ${title} (${consentType}), signerat av ${identity.signerName ?? 'okänd'} ${identity.pnMasked ?? ''}`,
    new_state: { consent_type: consentType, signer_name: identity.signerName, personal_number_masked: identity.pnMasked },
  })

  // Flow side effects.
  if (context.kind === 'arsredovisning_signature' && typeof context.signature_request_id === 'string' && row.company_id) {
    try {
      await markSignatureSigned(supabase, row.company_id, context.signature_request_id, {
        bankidSignatureData: {
          consent_id: consentId,
          bankid_session_id: row.id,
          signer_name: identity.signerName,
          personal_number_masked: identity.pnMasked,
          signed_at: identity.completedAt,
        },
      })
    } catch (err) {
      log.error('failed to mark arsredovisning signature signed', err as Error, {
        signatureRequestId: context.signature_request_id,
      })
    }
  }

  return consentId
}

export interface CancelConsentResult {
  status: 'cancelled' | 'already_cancelled'
}

/**
 * Cancel a PENDING consent-signing session (user closed the dialog or
 * changed their mind). Cancels the provider order, flips the session status
 * and writes an audit row. Terminal sessions cannot be cancelled — a
 * completed signature is evidence and must be revoked, not cancelled.
 */
export async function cancelConsentSession(
  supabase: SupabaseClient,
  args: { sessionId: string; userId: string },
): Promise<CancelConsentResult> {
  const { data: session, error } = await supabase
    .from('bankid_sessions')
    .select('id, user_id, company_id, status, provider_session_ref')
    .eq('id', args.sessionId)
    .eq('user_id', args.userId)
    .maybeSingle()

  if (error || !session) {
    throw new Error('Signeringssessionen kunde inte hittas.')
  }

  const row = session as {
    id: string
    user_id: string
    company_id: string | null
    status: string
    provider_session_ref: string
  }

  if (row.status === 'cancelled') return { status: 'already_cancelled' }
  if (row.status !== 'pending') {
    throw new Error('Sessionen är redan slutförd och kan inte avbrytas. Använd återkallelse för signerade samtycken.')
  }

  const provider = getBankIdProvider()
  await provider.cancel(row.provider_session_ref).catch(() => {
    // Provider cancel is best-effort — the local status flip is what stops
    // the poll loop and prevents a late completion from being consumed.
  })

  // CAS on status so a racing completion is never overwritten to cancelled.
  const { data: updated } = await supabase
    .from('bankid_sessions')
    .update({ status: 'cancelled', hint_code: 'userCancel', updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select('id')

  if (!updated || (updated as unknown[]).length === 0) {
    throw new Error('Sessionen hann slutföras och kan inte längre avbrytas.')
  }

  await supabase.from('audit_log').insert({
    user_id: row.user_id,
    company_id: row.company_id,
    action: 'SECURITY_EVENT',
    table_name: 'bankid_sessions',
    record_id: row.id,
    actor_id: args.userId,
    description: 'BankID-signering avbruten av användaren.',
    new_state: { status: 'cancelled' },
  })

  return { status: 'cancelled' }
}

export async function revokeConsent(
  supabase: SupabaseClient,
  args: { consentId: string; companyId: string; userId: string },
): Promise<void> {
  const { data: updated, error } = await supabase
    .from('signed_consents')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      revoked_by: args.userId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.consentId)
    .eq('company_id', args.companyId)
    .eq('status', 'active')
    .select('id, consent_type, title')
    .maybeSingle()

  if (error) {
    throw new Error(`Samtycket kunde inte återkallas: ${error.message}`)
  }
  if (!updated) {
    throw new Error('Samtycket kunde inte hittas eller är redan återkallat.')
  }

  await supabase.from('audit_log').insert({
    user_id: args.userId,
    company_id: args.companyId,
    action: 'SECURITY_EVENT',
    table_name: 'signed_consents',
    record_id: args.consentId,
    actor_id: args.userId,
    description: `Samtycke återkallat: ${(updated as { title: string }).title}`,
    new_state: { status: 'revoked' },
  })
}
