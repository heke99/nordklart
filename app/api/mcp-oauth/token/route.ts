import { NextResponse } from 'next/server'
import { decryptAuthCode, verifyPkce, hashAuthCode } from '@/lib/auth/oauth-codes'
import {
  generateApiKey,
  generateRefreshToken,
  hashRefreshToken,
  createServiceClientNoCookies,
  validateScopes,
  DEFAULT_OAUTH_SCOPES,
  type ApiKeyScope,
} from '@/lib/auth/api-keys'
import { requireCompanyId } from '@/lib/company/context'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { truncateIp } from '@/lib/api/v1/with-api-v1'

const ACCESS_TOKEN_TTL_SECONDS = 3600
// Clients are told to refresh hourly (expires_in); the key itself stops
// working server-side after a day, and an unused refresh token after 60 days.
const ACCESS_KEY_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000
const REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000

// The sibling /register endpoint has carried a per-/24 limit since it shipped;
// the token endpoint did not, even though it is the one that hands out
// credentials. Codes and refresh tokens are high-entropy, so this is depth
// rather than the only defence — but an unauthenticated endpoint that performs
// crypto and database work on every call should not be free to hammer.
const TOKEN_RATE_LIMIT = {
  maxRequests: 30,
  windowMs: 60 * 1000,
}

/**
 * OAuth 2.0 Token Endpoint.
 *
 * Supports two grant types:
 *   - authorization_code: exchange a PKCE-protected auth code for a fresh
 *     api_key (access_token) plus a refresh_token.
 *   - refresh_token: rotate the refresh_token and the api_key. The key
 *     expires server-side after ACCESS_KEY_MAX_LIFETIME_MS, the refresh token
 *     after REFRESH_TOKEN_LIFETIME_MS without use, and replaying a rotated
 *     refresh token revokes the key (rotate_api_key_refresh).
 */
export async function POST(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')
  const rawIp = forwarded
    ? forwarded.split(',')[0]?.trim()
    : request.headers.get('x-real-ip') ?? undefined
  const rl = await checkDurableRateLimit({
    prefix: 'mcp-oauth:token',
    identifier: truncateIp(rawIp || undefined) ?? 'unknown',
    ...TOKEN_RATE_LIMIT,
  })
  if (!rl.ok) return rl.response!

  let params: URLSearchParams

  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const text = await request.text()
    params = new URLSearchParams(text)
  } else if (contentType.includes('application/json')) {
    const json = await request.json()
    params = new URLSearchParams(json as Record<string, string>)
  } else {
    return NextResponse.json({ error: 'unsupported_content_type' }, { status: 400 })
  }

  const grantType = params.get('grant_type')

  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeGrant(params)
  }

  if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(params)
  }

  return NextResponse.json(
    {
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code and refresh_token are supported',
    },
    { status: 400 }
  )
}

async function handleAuthorizationCodeGrant(params: URLSearchParams) {
  const code = params.get('code')
  const codeVerifier = params.get('code_verifier')
  const redirectUri = params.get('redirect_uri')

  if (!code) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Missing code parameter' },
      { status: 400 }
    )
  }

  const payload = decryptAuthCode(code)
  if (!payload) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Invalid or expired authorization code' },
      { status: 400 }
    )
  }

  if (redirectUri && redirectUri !== payload.redirectUri) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'redirect_uri mismatch' },
      { status: 400 }
    )
  }

  if (!codeVerifier) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'code_verifier is required' },
      { status: 400 }
    )
  }

  if (!verifyPkce(codeVerifier, payload.codeChallenge)) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'PKCE verification failed' },
      { status: 400 }
    )
  }

  const codeHash = hashAuthCode(code)
  const supabase = createServiceClientNoCookies()

  const { error: replayError } = await supabase
    .from('oauth_used_codes')
    .insert({ code_hash: codeHash })

  if (replayError) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'Authorization code already used' },
      { status: 400 }
    )
  }

  // Clean up expired codes (non-blocking, best-effort)
  supabase
    .from('oauth_used_codes')
    .delete()
    .lt('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .then(() => {})

  // The company the user saw on the consent screen, not whichever one
  // happens to be active when the client exchanges the code.
  const companyId = payload.companyId ?? await requireCompanyId(supabase, payload.userId)
  const { data: access } = await supabase.rpc('api_key_owner_is_active', {
    p_user_id: payload.userId,
    p_company_id: companyId,
  })
  if (access !== true) {
    return NextResponse.json(
      { error: 'invalid_grant', error_description: 'The user no longer has access to the company' },
      { status: 400 }
    )
  }

  const { key, hash, prefix } = generateApiKey()
  const refresh = generateRefreshToken()

  // Use the scopes the user consented to during /authorize. Re-validate
  // every value against API_KEY_SCOPES even though /authorize already did
  // — the auth code is AEAD-encrypted but we treat the boundary as
  // hostile by default (V9.2.1, defense-in-depth).
  let grantedScopes: ApiKeyScope[]
  if (payload.scopes && Array.isArray(payload.scopes) && payload.scopes.length > 0) {
    const revalidated = validateScopes(payload.scopes)
    if (!revalidated) {
      return NextResponse.json(
        { error: 'invalid_grant', error_description: 'Authorization code carried no valid scopes' },
        { status: 400 }
      )
    }
    grantedScopes = revalidated
  } else {
    // Code minted with no scope (Claude's existing flow). Fall back to the
    // read-only OAuth defaults — destructive scopes must be requested
    // explicitly (GDPR Art. 25(2)).
    grantedScopes = DEFAULT_OAUTH_SCOPES
  }

  const { error: insertError } = await supabase
    .from('api_keys')
    .insert({
      user_id: payload.userId,
      company_id: companyId,
      key_hash: hash,
      key_prefix: prefix,
      name: 'MCP-klient (OAuth)',
      scopes: grantedScopes,
      refresh_token_hash: refresh.hash,
      expires_at: new Date(Date.now() + ACCESS_KEY_MAX_LIFETIME_MS).toISOString(),
      refresh_expires_at: new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS).toISOString(),
    })

  if (insertError) {
    return NextResponse.json(
      { error: 'server_error', error_description: 'Failed to create API key' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    access_token: key,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.token,
    scope: grantedScopes.join(' '),
  })
}

async function handleRefreshTokenGrant(params: URLSearchParams) {
  const refreshToken = params.get('refresh_token')
  if (!refreshToken) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'refresh_token is required' },
      { status: 400 }
    )
  }

  const supabase = createServiceClientNoCookies()
  const rotated = generateRefreshToken()
  const { key: newKey, hash: newKeyHash, prefix: newKeyPrefix } = generateApiKey()

  // One transaction: find the key by refresh token (CAS on the hash),
  // re-check the owner's access, rotate key + refresh token and extend their
  // lifetimes. A replayed, already-rotated refresh token revokes the key.
  const { data, error } = await supabase.rpc('rotate_api_key_refresh', {
    p_presented_refresh_hash: hashRefreshToken(refreshToken),
    p_new_refresh_hash: rotated.hash,
    p_new_key_hash: newKeyHash,
    p_new_key_prefix: newKeyPrefix,
    p_access_ttl: `${ACCESS_KEY_MAX_LIFETIME_MS / 1000} seconds`,
    p_refresh_ttl: `${REFRESH_TOKEN_LIFETIME_MS / 1000} seconds`,
  })

  if (error || !data) {
    return NextResponse.json(
      { error: 'server_error', error_description: 'Failed to rotate refresh token' },
      { status: 500 }
    )
  }

  const result = data as { ok: boolean; error?: string; scopes?: unknown }
  if (!result.ok) {
    const description: Record<string, string> = {
      refresh_token_reused: 'Refresh token already used; the grant has been revoked',
      refresh_token_expired: 'Refresh token expired',
      access_revoked: 'The user no longer has access to the company',
      revoked: 'Refresh token revoked',
    }
    return NextResponse.json(
      { error: 'invalid_grant', error_description: description[result.error ?? ''] ?? 'Invalid refresh token' },
      { status: 400 }
    )
  }
  const row = { scopes: result.scopes }

  // Return the granular scopes the key was originally minted with. Falling
  // back to the read-only OAuth defaults preserves the pre-scope-plumbing
  // behaviour for legacy keys whose scopes column is null.
  const persistedScopes = validateScopes(row.scopes) ?? DEFAULT_OAUTH_SCOPES

  return NextResponse.json({
    access_token: newKey,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: rotated.token,
    scope: persistedScopes.join(' '),
  })
}
