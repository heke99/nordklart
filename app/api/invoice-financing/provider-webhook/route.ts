import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import type { FinancingApplicationStatus } from '@/lib/invoice-financing/types'
import { FINANCING_TERMINAL_STATUSES } from '@/lib/invoice-financing/types'

ensureInitialized()

const log = createLogger('invoice-financing-provider-webhook')

/**
 * POST /api/invoice-financing/provider-webhook — provider → us status pushes.
 *
 * Production financing partners answer applications asynchronously (credit
 * checks take time) and report settlement/recourse events after payout. They
 * are configured with this URL + a shared secret when the agreement is set
 * up.
 *
 * Auth: shared secret in the X-Financing-Webhook-Secret header, compared
 * constant-time against INVOICE_FINANCING_WEBHOOK_SECRET.
 *
 * The webhook only ADVANCES status along legal transitions — a terminal
 * application is never resurrected, and payout/booking is NOT triggered from
 * here (acceptance always runs through the accept endpoint where the company
 * acts). Settlement/recourse events after payout are recorded verbatim.
 */

const WebhookBody = z.object({
  provider_reference: z.string().min(1).max(200),
  status: z.enum(['needs_more_info', 'offer_created', 'rejected', 'settled', 'recourse']),
  message: z.string().max(2000).optional(),
  offer: z
    .object({
      offered_amount: z.number().positive(),
      fee_percent: z.number().min(0).max(100),
      fee_amount: z.number().min(0),
      payout_amount: z.number().positive(),
      recourse: z.boolean().optional(),
      valid_until: z.string().datetime().optional(),
    })
    .optional(),
})

/** Transitions a provider webhook may perform (status_from → allowed next). */
const ALLOWED_TRANSITIONS: Record<string, FinancingApplicationStatus[]> = {
  submitted: ['needs_more_info', 'offer_created', 'rejected'],
  needs_more_info: ['offer_created', 'rejected'],
  offer_created: ['rejected'],
  paid_out: ['settled', 'recourse'],
  recourse: ['settled'],
}

export async function POST(request: Request) {
  const configured = process.env.INVOICE_FINANCING_WEBHOOK_SECRET
  if (!configured) {
    return NextResponse.json(
      { error: 'Fakturafinansiering-webhooken är inte konfigurerad (INVOICE_FINANCING_WEBHOOK_SECRET saknas).' },
      { status: 503 },
    )
  }
  const presented = request.headers.get('x-financing-webhook-secret') ?? ''
  const a = Buffer.from(presented)
  const b = Buffer.from(configured)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body is not valid JSON.' }, { status: 400 })
  }
  const parsed = WebhookBody.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Ogiltig payload.', issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    )
  }
  const body = parsed.data

  const supabase = createServiceClientNoCookies()

  const { data: appRow } = await supabase
    .from('invoice_financing_applications')
    .select('id, company_id, invoice_id, status, recourse, created_by')
    .eq('provider_reference', body.provider_reference)
    .maybeSingle()

  if (!appRow) {
    return NextResponse.json({ error: 'Okänd ansökan (provider_reference matchar ingen rad).' }, { status: 404 })
  }
  const application = appRow as {
    id: string
    company_id: string
    invoice_id: string
    status: FinancingApplicationStatus
    recourse: boolean
    created_by: string | null
  }

  const allowed = ALLOWED_TRANSITIONS[application.status] ?? []
  if (FINANCING_TERMINAL_STATUSES.has(application.status) || !allowed.includes(body.status)) {
    return NextResponse.json(
      {
        error: `Otillåten statusövergång: ${application.status} → ${body.status}.`,
      },
      { status: 409 },
    )
  }

  // Record the offer when the provider attaches one.
  if (body.status === 'offer_created' && body.offer) {
    const { error: offerErr } = await supabase.from('invoice_financing_offers').insert({
      company_id: application.company_id,
      application_id: application.id,
      offered_amount: body.offer.offered_amount,
      fee_percent: body.offer.fee_percent,
      fee_amount: body.offer.fee_amount,
      payout_amount: body.offer.payout_amount,
      recourse: body.offer.recourse ?? application.recourse,
      valid_until: body.offer.valid_until ?? null,
      status: 'open',
      provider_reference: body.provider_reference,
    })
    if (offerErr) {
      log.error('provider webhook offer insert failed', offerErr, { applicationId: application.id })
      return NextResponse.json({ error: 'Erbjudandet kunde inte sparas.' }, { status: 500 })
    }
  }

  const { error: updateErr } = await supabase
    .from('invoice_financing_applications')
    .update({
      status: body.status,
      error_message: body.status === 'rejected' || body.status === 'needs_more_info' ? (body.message ?? null) : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', application.id)

  if (updateErr) {
    log.error('provider webhook status update failed', updateErr, { applicationId: application.id })
    return NextResponse.json({ error: 'Statusen kunde inte uppdateras.' }, { status: 500 })
  }

  await supabase.from('invoice_financing_events').insert({
    company_id: application.company_id,
    application_id: application.id,
    event_type: `provider_webhook_${body.status}`,
    status_from: application.status,
    status_to: body.status,
    payload: { message: body.message ?? null, offer: body.offer ?? null },
  })

  if (body.status === 'offer_created') {
    try {
      await eventBus.emit({
        type: 'invoice_financing.offer_created',
        payload: {
          applicationId: application.id,
          invoiceId: application.invoice_id,
          offeredAmount: body.offer?.offered_amount ?? null,
          userId: application.created_by ?? 'provider-webhook',
          companyId: application.company_id,
        },
      })
    } catch (err) {
      log.warn('invoice_financing.offer_created emit failed', { error: (err as Error).message })
    }
  }

  return NextResponse.json({ data: { application_id: application.id, status: body.status } })
}
