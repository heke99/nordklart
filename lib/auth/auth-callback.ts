export type AuthCallbackFlow =
  | 'signup'
  | 'recovery'
  | 'invite'
  | 'magiclink'
  | 'email_change'
  | 'unknown'

export type AuthCallbackMethod = 'pkce_code' | 'token_hash' | 'none'

export type AuthOtpType =
  | 'signup'
  | 'invite'
  | 'magiclink'
  | 'recovery'
  | 'email_change'
  | 'email'

const OTP_TYPES = new Set<AuthOtpType>([
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
])

const INTERNAL_ORIGIN = 'https://nordklart.invalid'

const ALLOWED_CALLBACK_PREFIXES = [
  '/app',
  '/onboarding',
  '/reset-password',
  '/select-company',
  '/settings/account',
  '/mfa/verify',
] as const

export function isAuthOtpType(value: string | null): value is AuthOtpType {
  return value !== null && OTP_TYPES.has(value as AuthOtpType)
}

export function resolveAuthCallbackFlow(params: {
  type?: string | null
  flow?: string | null
  next?: string | null
}): AuthCallbackFlow {
  const type = params.type?.trim().toLowerCase()
  const explicitFlow = params.flow?.trim().toLowerCase()

  if (type === 'recovery') return 'recovery'
  if (type === 'invite') return 'invite'
  if (type === 'magiclink') return 'magiclink'
  if (type === 'email_change') return 'email_change'

  if (explicitFlow === 'signup' || explicitFlow === 'confirmation') return 'signup'
  if (explicitFlow === 'recovery' || explicitFlow === 'password_reset') return 'recovery'
  if (explicitFlow === 'invite') return 'invite'
  if (explicitFlow === 'magiclink') return 'magiclink'
  if (explicitFlow === 'email_change') return 'email_change'

  if (params.next === '/reset-password') return 'recovery'
  if (params.next?.startsWith('/onboarding')) return 'signup'

  // Supabase's custom confirm-signup template commonly uses type=email.
  if (type === 'signup' || type === 'email') return 'signup'

  return 'unknown'
}

export function defaultRedirectForAuthFlow(flow: AuthCallbackFlow): string {
  switch (flow) {
    case 'signup':
      return '/onboarding'
    case 'recovery':
      return '/reset-password'
    case 'email_change':
      return '/settings/account'
    case 'invite':
    case 'magiclink':
    case 'unknown':
    default:
      return '/app'
  }
}

/**
 * Accept only known internal application paths. Auth callback destinations
 * must never be controlled by an external query parameter.
 */
export function safeAuthRedirectPath(rawPath: string | null, fallback: string): string {
  if (!rawPath || !rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) {
    return fallback
  }

  try {
    const parsed = new URL(rawPath, INTERNAL_ORIGIN)
    if (parsed.origin !== INTERNAL_ORIGIN) return fallback

    const allowed = ALLOWED_CALLBACK_PREFIXES.some(
      (prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`),
    )

    if (!allowed) return fallback
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return fallback
  }
}

export function authCallbackErrorParam(flow: AuthCallbackFlow): string {
  switch (flow) {
    case 'signup':
      return 'signup_confirmation_failed'
    case 'recovery':
      return 'password_reset_failed'
    case 'invite':
      return 'invite_failed'
    case 'magiclink':
      return 'magic_link_failed'
    case 'email_change':
      return 'email_change_failed'
    case 'unknown':
    default:
      return 'auth_link_failed'
  }
}

/**
 * Stores a small, non-sensitive reason code. Never return raw Supabase errors,
 * codes, tokens or redirect parameters to the browser or application logs.
 */
export function classifyAuthCallbackFailure(error: unknown): string {
  const source =
    error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message.toLowerCase()
      : ''

  if (source.includes('code verifier') || source.includes('pkce')) {
    return 'pkce_verifier_missing'
  }
  if (source.includes('redirect')) {
    return 'redirect_not_allowed'
  }
  if (
    source.includes('expired') ||
    source.includes('invalid') ||
    source.includes('used') ||
    source.includes('otp')
  ) {
    return 'expired_or_invalid_link'
  }
  if (source.includes('not found')) {
    return 'user_or_token_not_found'
  }
  return 'auth_verification_failed'
}
