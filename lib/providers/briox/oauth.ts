import { BRIOX_TOKEN_URL, BRIOX_REFRESH_URL } from './config';
import type { TokenResponse } from '../types';
import {
  fetchWithTimeout,
  OAUTH_TIMEOUT_MS,
} from '@/lib/http/fetch-with-timeout';

interface BrioxTokenData {
  access_token: string;
  refresh_token: string;
  client_id: number;
  expire_date: string;
  expire_timestamp: number;
}

interface BrioxTokenApiResponse {
  data: BrioxTokenData;
}

function toTokenResponse(brioxData: BrioxTokenData): TokenResponse {
  const expiresIn = brioxData.expire_timestamp - Math.floor(Date.now() / 1000);
  return {
    access_token: brioxData.access_token,
    refresh_token: brioxData.refresh_token,
    token_type: 'Bearer',
    expires_in: expiresIn > 0 ? expiresIn : 3600,
  };
}

export async function exchangeBrioxCode(
  clientId: string,
  applicationToken: string,
): Promise<TokenResponse> {
  const url = `${BRIOX_TOKEN_URL}?clientid=${encodeURIComponent(clientId)}&token=${encodeURIComponent(applicationToken)}`;

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Briox token exchange' },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Briox token exchange failed: ${response.status} ${body}`);
  }

  const result = await response.json() as BrioxTokenApiResponse;
  return toTokenResponse(result.data);
}

export async function refreshBrioxToken(
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const url = `${BRIOX_REFRESH_URL}?refreshtoken=${encodeURIComponent(refreshToken)}&token=${encodeURIComponent(refreshToken)}`;

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    },
    { timeoutMs: OAUTH_TIMEOUT_MS, description: 'Briox token refresh' },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Briox token refresh failed: ${response.status} ${body}`);
  }

  const result = await response.json() as BrioxTokenApiResponse;
  return toTokenResponse(result.data);
}
