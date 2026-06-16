import type { OAuthConfig } from './types';

export function getOAuthConfig(provider: string): OAuthConfig {
  if (provider === 'fortnox') {
    return {
      clientId: process.env.FORTNOX_CLIENT_ID ?? '',
      clientSecret: process.env.FORTNOX_CLIENT_SECRET ?? '',
      redirectUri: process.env.FORTNOX_REDIRECT_URI ?? '',
    };
  }
  if (provider === 'visma') {
    return {
      clientId: process.env.VISMA_CLIENT_ID ?? '',
      clientSecret: process.env.VISMA_CLIENT_SECRET ?? '',
      redirectUri: process.env.VISMA_REDIRECT_URI ?? '',
    };
  }
  if (provider === 'briox') {
    return {
      clientId: process.env.BRIOX_CLIENT_ID ?? '',
      clientSecret: '',
      redirectUri: '',
    };
  }
  if (provider === 'bokio') {
    return {
      clientId: '',
      clientSecret: '',
      redirectUri: '',
    };
  }
  if (provider === 'bjornlunden') {
    return {
      clientId: process.env.BJORN_LUNDEN_CLIENT_ID ?? '',
      clientSecret: process.env.BJORN_LUNDEN_CLIENT_SECRET ?? '',
      redirectUri: '',
    };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

export function validateProvider(provider: string): boolean {
  return provider === 'fortnox' || provider === 'visma' || provider === 'briox' || provider === 'bokio' || provider === 'bjornlunden';
}
