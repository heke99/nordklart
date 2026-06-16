import { createServiceClient } from '@/lib/supabase/server';
import type { TokenResponse } from './types';
import { getOAuthConfig } from './oauth-config';
import { refreshFortnoxToken } from './fortnox/oauth';
import { refreshVismaToken } from './visma/oauth';
import { refreshBrioxToken } from './briox/oauth';
import { refreshBjornLundenToken } from './bjornlunden/oauth';

export interface ResolvedConsent {
  consent: Record<string, unknown>;
  accessToken: string;
  providerCompanyId?: string;
}

export async function resolveConsent(companyId: string, consentId: string): Promise<ResolvedConsent> {
  const supabase = createServiceClient();

  // Load consent
  const { data: consentRows } = await supabase
    .from('provider_consents')
    .select('*')
    .eq('id', consentId)
    .eq('company_id', companyId)
    .limit(1);

  if (!consentRows || consentRows.length === 0) {
    throw { status: 404, message: 'Consent not found' };
  }

  const consent = consentRows[0]!;
  // Accept status 0 (token submitted, migration pending) and 1 (fully accepted)
  if (consent.status !== 0 && consent.status !== 1) {
    throw { status: 403, message: 'Consent is not in a valid status' };
  }

  if (!consent.provider) {
    throw { status: 400, message: 'Consent has no provider set — complete onboarding first' };
  }

  // Load tokens
  const { data: tokenRows } = await supabase
    .from('provider_consent_tokens')
    .select('*')
    .eq('consent_id', consentId)
    .limit(1);

  if (!tokenRows || tokenRows.length === 0) {
    throw { status: 401, message: 'No tokens found for this consent — complete OAuth first' };
  }

  const tokens = tokenRows[0]!;

  // Bokio: private API tokens that don't expire
  if (consent.provider === 'bokio') {
    return {
      consent,
      accessToken: tokens.access_token as string,
      providerCompanyId: tokens.provider_company_id as string | undefined,
    };
  }

  // Björn Lunden: client credentials — auto-refresh when expired
  if (consent.provider === 'bjornlunden') {
    if (tokens.token_expires_at && new Date(tokens.token_expires_at as string) < new Date()) {
      const refreshed = await refreshBjornLundenToken();
      const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

      await supabase
        .from('provider_consent_tokens')
        .update({
          access_token: refreshed.access_token,
          token_expires_at: newExpiresAt,
        })
        .eq('consent_id', consentId);

      return {
        consent,
        accessToken: refreshed.access_token,
        providerCompanyId: tokens.provider_company_id as string | undefined,
      };
    }

    return {
      consent,
      accessToken: tokens.access_token as string,
      providerCompanyId: tokens.provider_company_id as string | undefined,
    };
  }

  // Check expiry, auto-refresh if needed
  if (tokens.token_expires_at && new Date(tokens.token_expires_at as string) < new Date()) {
    if (!tokens.refresh_token) {
      throw { status: 401, message: 'Access token expired and no refresh token available' };
    }

    const config = getOAuthConfig(consent.provider as string);
    let refreshed: TokenResponse;

    if (consent.provider === 'fortnox') {
      refreshed = await refreshFortnoxToken(config, tokens.refresh_token as string);
    } else if (consent.provider === 'briox') {
      refreshed = await refreshBrioxToken(config.clientId, tokens.refresh_token as string);
    } else {
      refreshed = await refreshVismaToken(config, tokens.refresh_token as string);
    }

    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

    await supabase
      .from('provider_consent_tokens')
      .update({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        token_expires_at: newExpiresAt,
      })
      .eq('consent_id', consentId);

    return { consent, accessToken: refreshed.access_token };
  }

  return { consent, accessToken: tokens.access_token as string };
}
