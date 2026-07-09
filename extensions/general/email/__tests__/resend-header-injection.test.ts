/**
 * Header-injection hardening for the Resend transport: CRLF and angle
 * brackets in user-controlled name parts must never reach the From header.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMock = vi.fn()
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => sendMock(...args) }
  },
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Nordklart' }),
}))

process.env.RESEND_API_KEY = 're_test_key'
process.env.RESEND_FROM_EMAIL = 'no-reply@nordklart.se'

import { ResendEmailService } from '../lib/resend-service'

describe('ResendEmailService header injection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendMock.mockResolvedValue({ data: { id: 'msg-1' }, error: null })
  })

  it('strips CRLF from fromName so headers cannot be injected', async () => {
    const service = new ResendEmailService()
    await service.sendEmail({
      to: 'kund@example.se',
      subject: 'Faktura',
      html: '<p>x</p>',
      fromName: 'Acme AB\r\nBcc: attacker@evil.se',
    })

    const payload = sendMock.mock.calls[0][0] as { from: string }
    // Without CR/LF the "Bcc:" text stays inert inside the display name —
    // it can never start a new header line. (The trailing <...> address is
    // the module-level RESEND_FROM_EMAIL captured at import time.)
    expect(payload.from).not.toContain('\r')
    expect(payload.from).not.toContain('\n')
    expect(payload.from).toMatch(/^Acme ABBcc: attacker@evil\.se via Nordklart <[^<>]+>$/)
  })

  it('strips angle brackets so the envelope address cannot be replaced', async () => {
    const service = new ResendEmailService()
    await service.sendEmail({
      to: 'kund@example.se',
      subject: 'Faktura',
      html: '<p>x</p>',
      fromName: 'Acme <attacker@evil.se>',
    })

    const payload = sendMock.mock.calls[0][0] as { from: string }
    // The attacker's angle brackets are stripped, so the ONLY address-shaped
    // token in the header is the configured sender at the end.
    expect(payload.from).toMatch(/^Acme attacker@evil\.se via Nordklart <[^<>]+>$/)
  })

  it('reports unconfigured when RESEND_FROM_EMAIL is the localhost placeholder', async () => {
    const original = process.env.RESEND_FROM_EMAIL
    process.env.RESEND_FROM_EMAIL = 'noreply@localhost'
    try {
      const service = new ResendEmailService()
      expect(service.isConfigured()).toBe(false)
      const result = await service.sendEmail({ to: 'a@b.se', subject: 'x', html: 'x' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('not configured')
      expect(sendMock).not.toHaveBeenCalled()
    } finally {
      process.env.RESEND_FROM_EMAIL = original
    }
  })
})
