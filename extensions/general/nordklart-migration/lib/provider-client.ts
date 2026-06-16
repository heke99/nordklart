/**
 * Direct provider client — replaces nordklart-client.ts.
 *
 * Instead of making HTTP calls to the Nordklart Sync gateway, this module
 * performs consent/OTC operations directly against Supabase and delegates
 * data fetching to the provider clients in lib/providers/.
 */

import { createServiceClient } from '@/lib/supabase/server'
import type { ProviderName } from '@/lib/providers/types'
import { getOAuthConfig } from '@/lib/providers/oauth-config'
import { buildFortnoxAuthUrl } from '@/lib/providers/fortnox/oauth'
import { exchangeFortnoxCode } from '@/lib/providers/fortnox/oauth'
import { buildVismaAuthUrl, exchangeVismaCode } from '@/lib/providers/visma/oauth'
import { refreshBjornLundenToken } from '@/lib/providers/bjornlunden/oauth'
import type { ConsentRecord, OtcResponse } from '../types'

// Re-export data fetching functions from the provider layer
export { resolveConsent } from '@/lib/providers/resolve-consent'
export {
  fetchCompanyInfoDirect,
  fetchCustomersDirect,
  fetchSuppliersDirect,
  fetchSalesInvoicesDirect,
  fetchSupplierInvoicesDirect,
} from '@/lib/providers/provider-data-fetcher'

// ── Consent lifecycle (direct Supabase) ─────────────────────────────

export async function createConsent(
  companyId: string,
  provider: ProviderName,
  name: string,
  orgNumber?: string,
  companyName?: string,
): Promise<ConsentRecord> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('provider_consents')
    .insert({
      company_id: companyId,
      name,
      provider,
      org_number: orgNumber,
      company_name: companyName,
      status: 0, // Created
    })
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(`Failed to create consent: ${error?.message}`)
  }

  return {
    id: data.id,
    name: data.name,
    provider: data.provider as ProviderName,
    status: data.status,
    orgNumber: data.org_number,
    companyName: data.company_name,
  }
}

export async function listConsents(companyId: string): Promise<ConsentRecord[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('provider_consents')
    .select('*')
    .eq('company_id', companyId)
    .in('status', [0, 1]) // Created or Accepted
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to list consents: ${error.message}`)
  }

  return (data ?? []).map(d => ({
    id: d.id,
    name: d.name,
    provider: d.provider as ProviderName,
    status: d.status,
    orgNumber: d.org_number,
    companyName: d.company_name,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  }))
}

export async function getConsent(consentId: string): Promise<ConsentRecord> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('provider_consents')
    .select('*')
    .eq('id', consentId)
    .single()

  if (error || !data) {
    throw new Error(`Consent not found: ${error?.message}`)
  }

  return {
    id: data.id,
    name: data.name,
    provider: data.provider as ProviderName,
    status: data.status,
    orgNumber: data.org_number,
    companyName: data.company_name,
  }
}

export async function deleteConsent(consentId: string): Promise<void> {
  const supabase = createServiceClient()

  // Delete tokens first (cascade should handle this, but be explicit)
  await supabase.from('provider_consent_tokens').delete().eq('consent_id', consentId)
  await supabase.from('provider_otc').delete().eq('consent_id', consentId)

  const { error } = await supabase
    .from('provider_consents')
    .delete()
    .eq('id', consentId)

  if (error) {
    throw new Error(`Failed to delete consent: ${error.message}`)
  }
}

export async function generateOtc(
  consentId: string,
  expiresInMinutes: number = 60,
): Promise<OtcResponse> {
  const supabase = createServiceClient()

  const code = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString()

  const { error } = await supabase
    .from('provider_otc')
    .insert({
      code,
      consent_id: consentId,
      expires_at: expiresAt,
    })

  if (error) {
    throw new Error(`Failed to generate OTC: ${error.message}`)
  }

  return { code, consentId, expiresAt }
}

// ── OAuth helpers (direct provider calls) ───────────────────────────

export async function getAuthUrl(
  provider: ProviderName,
  state?: string,
  redirectUri?: string,
): Promise<{ url: string }> {
  const config = getOAuthConfig(provider)

  // Override redirect URI if provided (extension callback URL)
  const effectiveConfig = redirectUri
    ? { ...config, redirectUri }
    : config

  if (provider === 'fortnox') {
    const url = buildFortnoxAuthUrl(effectiveConfig, { state })
    return { url }
  }

  if (provider === 'visma') {
    const url = buildVismaAuthUrl(effectiveConfig, { state })
    return { url }
  }

  throw new Error(`OAuth is not supported for provider: ${provider}`)
}

export async function exchangeAuthToken(
  consentId: string,
  provider: ProviderName,
  code: string,
  redirectUri?: string,
): Promise<{ success: boolean; consentId: string }> {
  const config = getOAuthConfig(provider)
  const effectiveConfig = redirectUri ? { ...config, redirectUri } : config
  const supabase = createServiceClient()

  let tokenResponse: { access_token: string; refresh_token: string; expires_in: number }

  if (provider === 'fortnox') {
    tokenResponse = await exchangeFortnoxCode(effectiveConfig, code)
  } else if (provider === 'visma') {
    tokenResponse = await exchangeVismaCode(effectiveConfig, code)
  } else {
    throw new Error(`OAuth exchange not supported for provider: ${provider}`)
  }

  const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()

  // Store tokens
  await supabase
    .from('provider_consent_tokens')
    .upsert({
      consent_id: consentId,
      provider,
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      token_expires_at: expiresAt,
    })

  // Mark consent as accepted
  await supabase
    .from('provider_consents')
    .update({ status: 1 })
    .eq('id', consentId)

  return { success: true, consentId }
}

export async function submitProviderToken(
  consentId: string,
  provider: ProviderName,
  apiToken: string,
  companyId?: string,
): Promise<{ success: boolean; consentId: string }> {
  const supabase = createServiceClient()

  let accessToken = apiToken
  let tokenExpiresAt: string | null = null

  // BL uses client credentials — get a real token
  if (provider === 'bjornlunden') {
    const tokenResponse = await refreshBjornLundenToken()
    accessToken = tokenResponse.access_token
    tokenExpiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
  }

  // Store tokens — consent stays at status 0 until migration/SIE import completes
  await supabase
    .from('provider_consent_tokens')
    .upsert({
      consent_id: consentId,
      provider,
      access_token: accessToken,
      refresh_token: null,
      token_expires_at: tokenExpiresAt,
      provider_company_id: companyId,
    })

  return { success: true, consentId }
}

/** Mark a consent as accepted (status 1) — call after migration or SIE import succeeds */
export async function acceptConsent(consentId: string): Promise<void> {
  const supabase = createServiceClient()
  await supabase
    .from('provider_consents')
    .update({ status: 1 })
    .eq('id', consentId)
}
