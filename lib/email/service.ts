/**
 * Email Service Interface
 *
 * Core defines the contract. The email extension registers a real
 * implementation (Resend). Without the extension, a no-op service
 * is used — email-dependent features degrade gracefully.
 *
 * Every registered implementation is wrapped in an auditing decorator that
 * records the outcome of each send in `email_deliveries` (service role) and
 * enforces optional dedupe keys so a replayed event never double-sends.
 */

export interface SendEmailOptions {
  to: string | string[]
  cc?: string | string[]
  subject: string
  html: string
  text?: string
  replyTo?: string
  fromName?: string
  attachments?: Array<{
    filename: string
    content: Buffer | string
    contentType?: string
  }>
  /** Audit/idempotency context recorded in email_deliveries. */
  context?: {
    companyId?: string | null
    /** Stable template identifier, e.g. 'invoice.send', 'agency.staff_invite'. */
    templateKey?: string
    /**
     * Same key ⇒ at most one successful send. A second send with a key that
     * already has a pending/sent delivery row is skipped and returns
     * `{ success: true, deduped: true }`.
     */
    dedupeKey?: string
  }
}

export interface SendEmailResult {
  success: boolean
  messageId?: string
  error?: string
  /** True when a dedupe key matched an existing delivery — nothing was sent. */
  deduped?: boolean
}

export interface EmailService {
  sendEmail(options: SendEmailOptions): Promise<SendEmailResult>
  isConfigured(): boolean
}

class NoopEmailService implements EmailService {
  async sendEmail(): Promise<SendEmailResult> {
    return { success: false, error: 'Email service not configured' }
  }
  isConfigured(): boolean {
    return false
  }
}

// ── Delivery audit (email_deliveries) ────────────────────────────────────────

async function getAuditClient() {
  // Dynamic import keeps this module importable outside a Next.js request
  // scope (unit tests, scripts) — the client is only needed when a
  // configured service actually sends.
  const { createServiceClient } = await import('@/lib/supabase/server')
  return createServiceClient()
}

async function claimDelivery(
  options: SendEmailOptions,
): Promise<{ id: string } | 'duplicate' | null> {
  try {
    const supabase = await getAuditClient()
    const recipient = Array.isArray(options.to) ? options.to.join(', ') : options.to
    const { data, error } = await supabase
      .from('email_deliveries')
      .insert({
        company_id: options.context?.companyId ?? null,
        template_key: options.context?.templateKey ?? null,
        recipient,
        subject: options.subject,
        status: 'pending',
        dedupe_key: options.context?.dedupeKey ?? null,
      })
      .select('id')
      .single()

    if (error) {
      // 23505 on the partial dedupe index: an equal dedupe_key already has a
      // pending/sent row — this send is a replay and must be skipped.
      if ((error as { code?: string }).code === '23505') return 'duplicate'
      // Audit unavailable (e.g. migration not applied yet) — never block the
      // send itself on the audit trail.
      return null
    }
    return { id: (data as { id: string }).id }
  } catch {
    return null
  }
}

async function finalizeDelivery(deliveryId: string, result: SendEmailResult): Promise<void> {
  try {
    const supabase = await getAuditClient()
    await supabase
      .from('email_deliveries')
      .update({
        status: result.success ? 'sent' : 'failed',
        provider_message_id: result.messageId ?? null,
        error: result.success ? null : (result.error ?? 'unknown'),
      })
      .eq('id', deliveryId)
  } catch {
    // Best-effort — the pending row still documents the attempt.
  }
}

class AuditedEmailService implements EmailService {
  constructor(private readonly inner: EmailService) {}

  isConfigured(): boolean {
    return this.inner.isConfigured()
  }

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    // Unconfigured services fail fast without touching the audit table.
    if (!this.inner.isConfigured()) {
      return this.inner.sendEmail(options)
    }

    const claim = await claimDelivery(options)
    if (claim === 'duplicate') {
      return { success: true, deduped: true }
    }

    const result = await this.inner.sendEmail(options)
    if (claim) {
      await finalizeDelivery(claim.id, result)
    }
    return result
  }
}

let emailService: EmailService = new NoopEmailService()

export function getEmailService(): EmailService {
  return emailService
}

export function registerEmailService(svc: EmailService): void {
  emailService = new AuditedEmailService(svc)
}
