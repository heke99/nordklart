/**
 * Browser helpers for the invite handoff. The invite landing page stores the
 * token in a short-lived cookie before sending the user to log in; after
 * authentication the user is sent back to /invite/[token], which accepts it
 * (and handles MFA). The cookie is cleared only once the invite page has an
 * outcome, so an MFA detour or a transient error does not lose the invite.
 */
export const INVITE_TOKEN_COOKIE = 'nordklart-invite-token'

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,200}$/

export function readPendingInviteToken(): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${INVITE_TOKEN_COOKIE}=([^;]+)`))
  const token = match?.[1] ? decodeURIComponent(match[1]) : null
  return token && TOKEN_PATTERN.test(token) ? token : null
}

export function pendingInvitePath(): string | null {
  const token = readPendingInviteToken()
  return token ? `/invite/${encodeURIComponent(token)}` : null
}

export function rememberPendingInvite(token: string): void {
  if (typeof document === 'undefined' || !TOKEN_PATTERN.test(token)) return
  const secure = window.location.protocol === 'https:' ? '; secure' : ''
  document.cookie = `${INVITE_TOKEN_COOKIE}=${encodeURIComponent(token)}; path=/; max-age=86400; samesite=lax${secure}`
}

export function clearPendingInvite(): void {
  if (typeof document === 'undefined') return
  document.cookie = `${INVITE_TOKEN_COOKIE}=; path=/; max-age=0`
}
