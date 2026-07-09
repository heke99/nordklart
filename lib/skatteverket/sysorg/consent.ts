import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Consent gate for sysorg SUBMISSION flows.
 *
 * With the CCG sysorg track Nordklart files to Skatteverket on the customer's
 * behalf using Nordklart's own credentials — unlike the BankID-OAuth track
 * where the customer signs every filing with their own BankID. Filing on
 * someone's behalf requires their explicit, evidenced mandate: an active
 * BankID-signed consent of type 'skatteverket' in signed_consents.
 *
 * Validation/read flows (kontrollera, hämta) do not require consent; the
 * gate applies at the submission boundary (lås/lämna underlag).
 */

export class SkvConsentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkvConsentError'
  }
}

export const SKV_CONSENT_REQUIRED_MESSAGE =
  'Företaget saknar ett aktivt BankID-signerat samtycke för Skatteverket. Be en behörig företrädare signera samtycket under Inställningar → BankID innan inlämning.'

export async function hasActiveSkatteverketConsent(
  supabase: SupabaseClient,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('signed_consents')
    .select('id')
    .eq('company_id', companyId)
    .eq('consent_type', 'skatteverket')
    .eq('status', 'active')
    .limit(1)
    .maybeSingle()
  if (error) return false
  return Boolean(data)
}

/**
 * Throws SkvConsentError unless the company has an active signed consent.
 * Fails CLOSED when the caller cannot provide a company context — a sysorg
 * submission without a resolved company must never reach Skatteverket.
 */
export async function assertSkatteverketSubmissionConsent(
  supabase: SupabaseClient | undefined,
  companyId: string | null | undefined,
): Promise<void> {
  if (!supabase || !companyId) {
    throw new SkvConsentError(
      'Inlämning kräver ett företagskontext med signerat samtycke — anropet saknar företag.',
    )
  }
  if (!(await hasActiveSkatteverketConsent(supabase, companyId))) {
    throw new SkvConsentError(SKV_CONSENT_REQUIRED_MESSAGE)
  }
}
