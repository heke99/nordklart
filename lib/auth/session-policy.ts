/**
 * Session lifetime policy, enforced by the middleware on top of Supabase's
 * own refresh-token rules (which let a session live until it is revoked).
 *
 * - Idle timeout: no page load for SESSION_IDLE_TIMEOUT_HOURS (default 12 h).
 * - Absolute timeout: SESSION_ABSOLUTE_TIMEOUT_HOURS (default 7 days) after
 *   the user last authenticated (password, BankID, TOTP, reset link…),
 *   whatever the activity.
 *
 * Either one signs the browser out (local scope) and sends the user to log
 * in again. Both are configurable per deployment.
 */
export const ACTIVITY_COOKIE = 'nordklart-last-activity'

function hours(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function sessionIdleTimeoutMs(): number {
  return hours(process.env.SESSION_IDLE_TIMEOUT_HOURS, 12) * 60 * 60 * 1000
}

export function sessionAbsoluteTimeoutMs(): number {
  return hours(process.env.SESSION_ABSOLUTE_TIMEOUT_HOURS, 7 * 24) * 60 * 60 * 1000
}

/** Latest authentication time (ms) from the session's AMR entries. */
export function latestAuthenticationAt(
  methods: ReadonlyArray<string | { method?: string; timestamp?: number }> | null | undefined,
): number | null {
  let latest: number | null = null
  for (const entry of methods ?? []) {
    if (typeof entry !== 'object' || typeof entry.timestamp !== 'number') continue
    const ms = entry.timestamp * 1000
    if (latest === null || ms > latest) latest = ms
  }
  return latest
}

export type SessionVerdict = 'ok' | 'idle_timeout' | 'absolute_timeout'

export function evaluateSessionAge(input: {
  authenticatedAt: number | null
  lastActivityAt: number | null
  now: number
  idleMs?: number
  absoluteMs?: number
}): SessionVerdict {
  const absoluteMs = input.absoluteMs ?? sessionAbsoluteTimeoutMs()
  const idleMs = input.idleMs ?? sessionIdleTimeoutMs()
  if (input.authenticatedAt !== null && input.now - input.authenticatedAt > absoluteMs) {
    return 'absolute_timeout'
  }
  if (input.lastActivityAt !== null && input.now - input.lastActivityAt > idleMs) {
    return 'idle_timeout'
  }
  return 'ok'
}

/**
 * Options for Supabase auth cookies. Secure whenever the app is served over
 * HTTPS; the lifetime is capped at the absolute timeout instead of the
 * library default of 400 days.
 */
export function supabaseCookieOptions(secure: boolean) {
  return {
    path: '/',
    sameSite: 'lax' as const,
    secure,
    maxAge: Math.floor(sessionAbsoluteTimeoutMs() / 1000),
  }
}

/** Server side: the configured app URL decides whether cookies are Secure. */
export function serverCookiesSecure(): boolean {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (appUrl && !appUrl.startsWith('__')) return appUrl.startsWith('https://')
  return process.env.NODE_ENV === 'production'
}
