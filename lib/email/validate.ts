/**
 * Pragmatic email address validation shared by every invoice-send path
 * (dashboard send, v1 API send, recurring auto-send, reminders).
 *
 * Deliberately stricter than the full RFC 5321 grammar: we reject addresses
 * containing whitespace or control characters (header-injection vectors) and
 * require a dotted domain, because these emails go to real customers via a
 * transactional provider that would bounce anything weirder anyway.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function isValidEmailAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 320) return false
  // Reject CR/LF and other control chars outright — never let a stored
  // address smuggle header content into the mail envelope.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return false
  return EMAIL_PATTERN.test(trimmed)
}
