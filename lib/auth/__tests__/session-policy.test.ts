import { describe, expect, it } from 'vitest'
import { evaluateSessionAge, latestAuthenticationAt } from '../session-policy'

const HOUR = 60 * 60 * 1000
const now = Date.UTC(2026, 8, 27, 12)

describe('session policy', () => {
  it('keeps a recent, active session', () => {
    expect(evaluateSessionAge({ authenticatedAt: now - 2 * HOUR, lastActivityAt: now - HOUR, now, idleMs: 12 * HOUR, absoluteMs: 168 * HOUR })).toBe('ok')
  })

  it('ends a session idle for longer than the idle timeout', () => {
    expect(evaluateSessionAge({ authenticatedAt: now - 20 * HOUR, lastActivityAt: now - 13 * HOUR, now, idleMs: 12 * HOUR, absoluteMs: 168 * HOUR })).toBe('idle_timeout')
  })

  it('ends a session past the absolute timeout even when active', () => {
    expect(evaluateSessionAge({ authenticatedAt: now - 169 * HOUR, lastActivityAt: now - 60_000, now, idleMs: 12 * HOUR, absoluteMs: 168 * HOUR })).toBe('absolute_timeout')
  })

  it('does not end a session only because the activity cookie is missing', () => {
    expect(evaluateSessionAge({ authenticatedAt: now - HOUR, lastActivityAt: null, now, idleMs: 12 * HOUR, absoluteMs: 168 * HOUR })).toBe('ok')
  })

  it('uses the most recent authentication method', () => {
    expect(latestAuthenticationAt([
      { method: 'password', timestamp: 1_000 },
      { method: 'totp', timestamp: 2_000 },
      'legacy-string',
    ])).toBe(2_000_000)
    expect(latestAuthenticationAt(undefined)).toBeNull()
  })
})
