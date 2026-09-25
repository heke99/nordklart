import type { SupabaseClient } from '@supabase/supabase-js'

export interface SignatureRequest {
  id: string
  user_id: string
  company_id: string
  fiscal_period_id: string
  role: string
  signer_name: string
  status: 'pending' | 'signed' | 'declined'
  signed_at: string | null
  created_at: string
  updated_at: string
  bankid_signature_data?: Record<string, unknown> | null
  /**
   * For a BankID signature: whether the signer holds a signing position in
   * Bolagsverket's register (from signed_consents.context). null = manual
   * signature or no check recorded.
   */
  registry_verified?: boolean | null
}

export interface CreateSignatureRequestInput {
  role: string
  signer_name: string
}

/**
 * List signature requests for a fiscal period's årsredovisning.
 */
export async function listSignatureRequests(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<SignatureRequest[]> {
  const { data, error } = await supabase
    .from('arsredovisning_signature_requests')
    .select('id, user_id, company_id, fiscal_period_id, role, signer_name, status, signed_at, created_at, updated_at, bankid_signature_data')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Failed to list signature requests: ${error.message}`)
  const requests = (data ?? []) as SignatureRequest[]

  const consentIds = requests
    .map((r) => r.bankid_signature_data?.consent_id)
    .filter((id): id is string => typeof id === 'string')
  const checks = new Map<string, boolean | null>()
  if (consentIds.length > 0) {
    const { data: consents } = await supabase
      .from('signed_consents')
      .select('id, context')
      .eq('company_id', companyId)
      .in('id', consentIds)
    for (const c of consents ?? []) {
      const check = (c.context as Record<string, unknown> | null)?.signer_registry_check as { matched?: boolean } | undefined
      checks.set(c.id as string, typeof check?.matched === 'boolean' ? check.matched : null)
    }
  }

  return requests.map((r) => {
    const consentId = r.bankid_signature_data?.consent_id
    return { ...r, registry_verified: typeof consentId === 'string' ? checks.get(consentId) ?? null : null }
  })
}

/**
 * Create one signature request per styrelseledamot / VD. The BankID call
 * itself isn't wired here — that ships in a follow-up that uses
 * lib/auth/bankid helpers to sign and write the result back via
 * markSignatureSigned(). For now this just records who is supposed to sign.
 */
export async function createSignatureRequest(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
  input: CreateSignatureRequestInput,
): Promise<SignatureRequest> {
  const { data, error } = await supabase
    .from('arsredovisning_signature_requests')
    .insert({
      user_id: userId,
      company_id: companyId,
      fiscal_period_id: fiscalPeriodId,
      role: input.role,
      signer_name: input.signer_name,
      status: 'pending',
    })
    .select('*')
    .single()
  if (error || !data) {
    throw new Error(`Failed to create signature request: ${error?.message ?? 'unknown'}`)
  }
  return data as SignatureRequest
}

/**
 * Mark a request as signed WITHOUT BankID evidence.
 *
 * The BankID path does not come through here: record_bankid_consent_v1 flips
 * the request in the same transaction as the consent, so the signature and its
 * evidence can never disagree. This remains for the manual
 * "Markera som signerad" affordance, where there is no BankID order to bind to.
 *
 * The DB trigger blocks further edits once signed, so this is a one-way
 * transition.
 */
export async function markSignatureSigned(
  supabase: SupabaseClient,
  companyId: string,
  requestId: string,
  options: { bankidSignatureData?: Record<string, unknown> } = {},
): Promise<SignatureRequest> {
  const { data, error } = await supabase
    .from('arsredovisning_signature_requests')
    .update({
      status: 'signed',
      signed_at: new Date().toISOString(),
      bankid_signature_data: options.bankidSignatureData ?? null,
    })
    .eq('id', requestId)
    .eq('company_id', companyId)
    .select('*')
    .single()
  if (error || !data) {
    throw new Error(`Failed to mark signature signed: ${error?.message ?? 'unknown'}`)
  }
  return data as SignatureRequest
}

/**
 * True when every signature request for the period is signed. The UI uses
 * this to enable the "Ladda ner fastställd PDF" button and to gate filing.
 */
export async function isFullySignedOff(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<boolean> {
  const requests = await listSignatureRequests(supabase, companyId, fiscalPeriodId)
  if (requests.length === 0) return false
  return requests.every((r) => r.status === 'signed')
}
