import type { SupabaseClient } from '@supabase/supabase-js'
import { getBankIdProvider } from '@/lib/auth/bankid-provider'
import { hashPersonalNumber, maskPersonalNumber } from '@/lib/auth/bankid'
import { markSignatureSigned } from '@/lib/bokslut/arsredovisning/signature-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('consent-service')

/**
 * BankID consent-signing service.
 *
 * Flow:
 *   1. startConsentSigning() — creates a bankid_sessions row + starts the
 *      provider sign session. The exact consent text is stored verbatim.
 *   2. pollConsentSession() — collects provider status; on completion writes
 *      the signed_consents row (immutable, DB-enforced), an audit_log entry,
 *      and executes any flow-context side effects (e.g. marking an
 *      årsredovisning signature request as signed).
 *   3. revokeConsent() — status flip + audit (the row itself is immutable).
 *
 * Personnummer is never stored in plaintext: hash (SHA-256) + masked
 * display value only.
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

  return {
    sessionId: (session as { id: string }).id,
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

  // Already terminal — idempotent poll.
  if (row.status === 'complete') {
    const { data: consent } = await supabase
      .from('signed_consents')
      .select('id')
      .eq('bankid_session_id', row.id)
      .maybeSingle()
    return { status: 'complete', hintCode: null, consentId: (consent as { id: string } | null)?.id ?? null }
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
    return { status: collected.status, hintCode: collected.hintCode, consentId: null }
  }

  // Complete: persist identity (hash + mask only) and create the consent.
  const pn = collected.user?.personalNumber ?? ''
  const pnHash = pn ? hashPersonalNumber(pn) : null
  const pnMasked = pn ? maskPersonalNumber(pn) : null
  const signerName = collected.user?.name ?? null
  const completedAt = collected.completedAt ?? new Date().toISOString()

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
      personal_number_hash: pnHash,
      personal_number_masked: pnMasked,
      signer_name: signerName,
      status: 'active',
      context,
    })
    .select('id')
    .single()

  if (consentErr || !consent) {
    log.error('signed_consents insert failed after completed BankID session', consentErr ?? undefined, {
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
    description: `BankID-signerat samtycke: ${title} (${consentType}), signerat av ${signerName ?? 'okänd'} ${pnMasked ?? ''}`,
    new_state: { consent_type: consentType, signer_name: signerName, personal_number_masked: pnMasked },
  })

  // Flow side effects.
  if (context.kind === 'arsredovisning_signature' && typeof context.signature_request_id === 'string' && row.company_id) {
    try {
      await markSignatureSigned(supabase, row.company_id, context.signature_request_id, {
        bankidSignatureData: {
          consent_id: consentId,
          bankid_session_id: row.id,
          signer_name: signerName,
          personal_number_masked: pnMasked,
          signed_at: completedAt,
        },
      })
    } catch (err) {
      log.error('failed to mark arsredovisning signature signed', err as Error, {
        signatureRequestId: context.signature_request_id,
      })
    }
  }

  return { status: 'complete', hintCode: null, consentId }
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
