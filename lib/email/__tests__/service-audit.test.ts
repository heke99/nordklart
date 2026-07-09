/**
 * AuditedEmailService: every configured send creates an email_deliveries row
 * (claim → send → finalize) and dedupe keys suppress replays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const inserted: Array<Record<string, unknown>> = []
const updated: Array<Record<string, unknown>> = []
let insertResult: { data: unknown; error: unknown } = { data: { id: 'delivery-1' }, error: null }

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, ...row })
        return {
          select: () => ({
            single: async () => insertResult,
          }),
        }
      },
      update: (row: Record<string, unknown>) => {
        updated.push({ table, ...row })
        return { eq: async () => ({ data: null, error: null }) }
      },
    }),
  }),
}))

import { registerEmailService, getEmailService, type EmailService } from '@/lib/email/service'

function makeInnerService(overrides: Partial<EmailService> = {}): EmailService & { sendCount: () => number } {
  let sends = 0
  return {
    isConfigured: () => true,
    sendEmail: async () => {
      sends += 1
      return { success: true, messageId: 'msg-1' }
    },
    sendCount: () => sends,
    ...overrides,
  }
}

describe('AuditedEmailService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    inserted.length = 0
    updated.length = 0
    insertResult = { data: { id: 'delivery-1' }, error: null }
  })

  it('records a delivery row for a successful send', async () => {
    const inner = makeInnerService()
    registerEmailService(inner)

    const result = await getEmailService().sendEmail({
      to: 'kund@example.se',
      subject: 'Faktura F-100 från Acme AB',
      html: '<p>x</p>',
      context: { companyId: 'company-1', templateKey: 'invoice.send' },
    })

    expect(result.success).toBe(true)
    expect(inner.sendCount()).toBe(1)
    expect(inserted[0]).toMatchObject({
      table: 'email_deliveries',
      company_id: 'company-1',
      template_key: 'invoice.send',
      recipient: 'kund@example.se',
      status: 'pending',
    })
    expect(updated[0]).toMatchObject({
      table: 'email_deliveries',
      status: 'sent',
      provider_message_id: 'msg-1',
    })
  })

  it('records the failure when the provider rejects', async () => {
    const inner = makeInnerService({
      sendEmail: async () => ({ success: false, error: 'quota exceeded' }),
    })
    registerEmailService(inner)

    const result = await getEmailService().sendEmail({
      to: 'kund@example.se',
      subject: 'Faktura',
      html: '<p>x</p>',
      context: { companyId: 'company-1', templateKey: 'invoice.send' },
    })

    expect(result.success).toBe(false)
    expect(updated[0]).toMatchObject({ status: 'failed', error: 'quota exceeded' })
  })

  it('suppresses replays when the dedupe key already has a delivery', async () => {
    insertResult = { data: null, error: { code: '23505', message: 'duplicate' } }
    const inner = makeInnerService()
    registerEmailService(inner)

    const result = await getEmailService().sendEmail({
      to: 'kund@example.se',
      subject: 'Påminnelse',
      html: '<p>x</p>',
      context: { companyId: 'company-1', templateKey: 'invoice.reminder', dedupeKey: 'reminder-1-level-1' },
    })

    expect(result).toEqual({ success: true, deduped: true })
    expect(inner.sendCount()).toBe(0)
  })
})
