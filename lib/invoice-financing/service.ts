import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type { Customer, Invoice } from '@/types'
import { checkFinancingEligibility, type EligibilityIssue } from './eligibility'
import { createFinancingPayoutEntry } from './accounting'
import { getFinancingProvider } from './provider'
import {
  FINANCING_REQUIRES_AGREEMENT_MESSAGE_SV,
  FINANCING_TERMINAL_STATUSES,
  type FinancingApplicationStatus,
} from './types'

const log = createLogger('invoice-financing-service')

export interface FinancingApplicationRow {
  id: string
  company_id: string
  invoice_id: string
  provider_slug: string
  status: FinancingApplicationStatus
  recourse: boolean
  requested_amount: number
  currency: string
  consent_id: string | null
  provider_reference: string | null
  error_message: string | null
  metadata: Record<string, unknown>
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface FinancingOfferRow {
  id: string
  application_id: string
  offered_amount: number
  fee_percent: number
  fee_amount: number
  payout_amount: number
  recourse: boolean
  valid_until: string | null
  status: 'open' | 'accepted' | 'declined' | 'expired'
  provider_reference: string | null
}

export type CreateApplicationOutcome =
  | { ok: false; code: 'NOT_FOUND'; message_sv: string }
  | { ok: false; code: 'PROVIDER_NOT_CONFIGURED'; message_sv: string }
  | { ok: false; code: 'NOT_ELIGIBLE'; message_sv: string; issues: EligibilityIssue[] }
  | { ok: false; code: 'ALREADY_ACTIVE'; message_sv: string }
  | { ok: false; code: 'DB_ERROR'; message_sv: string }
  | { ok: true; application: FinancingApplicationRow; offer: FinancingOfferRow | null; message_sv: string }

async function recordEvent(
  supabase: SupabaseClient,
  args: {
    companyId: string
    applicationId: string
    eventType: string
    statusFrom: string | null
    statusTo: string | null
    payload?: Record<string, unknown>
    userId?: string | null
  },
): Promise<void> {
  const { error } = await supabase.from('invoice_financing_events').insert({
    company_id: args.companyId,
    application_id: args.applicationId,
    event_type: args.eventType,
    status_from: args.statusFrom,
    status_to: args.statusTo,
    payload: args.payload ?? {},
    created_by: args.userId ?? null,
  })
  if (error) {
    log.warn('failed to record financing event', { eventType: args.eventType, error: error.message })
  }
}

/**
 * Create a financing application for a sent customer invoice.
 *
 * Flow: eligibility → insert application (submitted) → provider submit →
 * offer_created | needs_more_info | rejected, with an append-only event per
 * transition and webhook emission on offer_created.
 */
export async function createFinancingApplication(
  supabase: SupabaseClient,
  args: {
    companyId: string
    userId: string
    invoiceId: string
    providerSlug?: string
    recourse?: boolean
    consentId?: string | null
  },
): Promise<CreateApplicationOutcome> {
  const providerSlug = args.providerSlug ?? 'sandbox'

  // Provider row (limits/config) + implementation.
  const { data: providerRow } = await supabase
    .from('invoice_financing_providers')
    .select('slug, name, status, recourse_default, min_amount, max_amount, fee_percent_default')
    .eq('slug', providerSlug)
    .maybeSingle()

  const provider = getFinancingProvider(providerSlug)
  if (!providerRow || providerRow.status !== 'active' || !provider) {
    return {
      ok: false,
      code: 'PROVIDER_NOT_CONFIGURED',
      message_sv: FINANCING_REQUIRES_AGREEMENT_MESSAGE_SV,
    }
  }

  // Invoice + customer.
  const { data: invoiceRow, error: invErr } = await supabase
    .from('invoices')
    .select('*, customer:customers(*)')
    .eq('id', args.invoiceId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  if (invErr || !invoiceRow) {
    return { ok: false, code: 'NOT_FOUND', message_sv: 'Fakturan kunde inte hittas.' }
  }
  const invoice = invoiceRow as unknown as Invoice & { customer: Customer | null }
  const customer = invoice.customer

  // Eligibility.
  const issues = checkFinancingEligibility({
    invoice,
    customer,
    provider: {
      min_amount: Number(providerRow.min_amount),
      max_amount: providerRow.max_amount == null ? null : Number(providerRow.max_amount),
    },
  })
  if (issues.length > 0) {
    return {
      ok: false,
      code: 'NOT_ELIGIBLE',
      message_sv: `Fakturan uppfyller inte villkoren för finansiering (${issues.length} hinder).`,
      issues,
    }
  }

  const recourse = args.recourse ?? providerRow.recourse_default ?? false
  const requestedAmount = roundOre(invoice.total)

  // Insert (unique partial index blocks a second live application per invoice).
  const { data: inserted, error: insertErr } = await supabase
    .from('invoice_financing_applications')
    .insert({
      company_id: args.companyId,
      invoice_id: args.invoiceId,
      provider_slug: providerSlug,
      status: 'submitted',
      recourse,
      requested_amount: requestedAmount,
      currency: invoice.currency,
      consent_id: args.consentId ?? null,
      created_by: args.userId,
    })
    .select('*')
    .single()

  if (insertErr || !inserted) {
    if (insertErr?.code === '23505') {
      return {
        ok: false,
        code: 'ALREADY_ACTIVE',
        message_sv: 'Det finns redan en pågående finansieringsansökan för denna faktura.',
      }
    }
    log.error('failed to insert financing application', { error: insertErr?.message })
    return { ok: false, code: 'DB_ERROR', message_sv: 'Ansökan kunde inte sparas. Försök igen.' }
  }

  let application = inserted as FinancingApplicationRow

  await recordEvent(supabase, {
    companyId: args.companyId,
    applicationId: application.id,
    eventType: 'application_submitted',
    statusFrom: null,
    statusTo: 'submitted',
    payload: { provider: providerSlug, requested_amount: requestedAmount, recourse },
    userId: args.userId,
  })

  // Provider round-trip.
  const result = await provider.submitApplication({
    applicationId: application.id,
    companyId: args.companyId,
    invoice: {
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      total: invoice.total,
      currency: invoice.currency,
      due_date: invoice.due_date,
    },
    customer: {
      name: customer?.name ?? '',
      org_number: customer?.org_number ?? null,
    },
    requestedAmount,
    recourse,
  })

  let offer: FinancingOfferRow | null = null

  if (result.status === 'offer_created') {
    const { data: offerRow, error: offerErr } = await supabase
      .from('invoice_financing_offers')
      .insert({
        company_id: args.companyId,
        application_id: application.id,
        offered_amount: result.offer.offeredAmount,
        fee_percent: result.offer.feePercent,
        fee_amount: result.offer.feeAmount,
        payout_amount: result.offer.payoutAmount,
        recourse: result.offer.recourse,
        valid_until: result.offer.validUntil,
        status: 'open',
        provider_reference: result.offer.providerReference,
      })
      .select('*')
      .single()
    if (offerErr) {
      log.error('failed to insert financing offer', { error: offerErr.message })
    }
    offer = (offerRow as FinancingOfferRow | null) ?? null
  }

  const nextStatus: FinancingApplicationStatus =
    result.status === 'offer_created' ? 'offer_created' : result.status
  const errorMessage = 'message_sv' in result ? result.message_sv : null

  const { data: updated } = await supabase
    .from('invoice_financing_applications')
    .update({
      status: nextStatus,
      provider_reference:
        result.status === 'offer_created' ? result.offer.providerReference : result.providerReference,
      error_message: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq('id', application.id)
    .select('*')
    .single()
  if (updated) application = updated as FinancingApplicationRow

  await recordEvent(supabase, {
    companyId: args.companyId,
    applicationId: application.id,
    eventType: `provider_${result.status}`,
    statusFrom: 'submitted',
    statusTo: nextStatus,
    payload: offer
      ? { offer_id: offer.id, payout_amount: offer.payout_amount, fee_amount: offer.fee_amount }
      : { message: errorMessage },
    userId: args.userId,
  })

  if (result.status === 'offer_created') {
    try {
      await eventBus.emit({
        type: 'invoice_financing.offer_created',
        payload: {
          applicationId: application.id,
          invoiceId: args.invoiceId,
          offeredAmount: offer?.offered_amount ?? null,
          userId: args.userId,
          companyId: args.companyId,
        },
      })
    } catch (err) {
      log.warn('invoice_financing.offer_created emit failed', { error: (err as Error).message })
    }
  }

  const message_sv =
    result.status === 'offer_created'
      ? `Erbjudande skapat: utbetalning ${offer?.payout_amount?.toLocaleString('sv-SE')} kr (avgift ${offer?.fee_amount?.toLocaleString('sv-SE')} kr).`
      : result.status === 'needs_more_info'
        ? (errorMessage ?? 'Finansiären behöver kompletterande uppgifter.')
        : (errorMessage ?? 'Ansökan avslogs av finansiären.')

  return { ok: true, application, offer, message_sv }
}

export type AcceptOfferOutcome =
  | { ok: false; code: 'NOT_FOUND' | 'INVALID_STATE' | 'OFFER_EXPIRED' | 'PROVIDER_ERROR'; message_sv: string }
  | {
      ok: true
      application: FinancingApplicationRow
      journalEntryId: string | null
      message_sv: string
    }

/**
 * Accept an open offer: provider pays out, the receivable is booked
 * (sold or pledged per recourse flag), a settlement row is written and
 * `invoice_financing.paid_out` is emitted.
 */
export async function acceptFinancingOffer(
  supabase: SupabaseClient,
  args: { companyId: string; userId: string; applicationId: string },
): Promise<AcceptOfferOutcome> {
  const { data: appRow } = await supabase
    .from('invoice_financing_applications')
    .select('*')
    .eq('id', args.applicationId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  if (!appRow) {
    return { ok: false, code: 'NOT_FOUND', message_sv: 'Ansökan kunde inte hittas.' }
  }
  let application = appRow as FinancingApplicationRow

  if (application.status !== 'offer_created') {
    return {
      ok: false,
      code: 'INVALID_STATE',
      message_sv: `Ansökan har inget öppet erbjudande att acceptera (status: ${application.status}).`,
    }
  }

  const { data: offerRow } = await supabase
    .from('invoice_financing_offers')
    .select('*')
    .eq('application_id', application.id)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const offer = offerRow as FinancingOfferRow | null
  if (!offer) {
    return { ok: false, code: 'INVALID_STATE', message_sv: 'Inget öppet erbjudande hittades.' }
  }
  if (offer.valid_until && new Date(offer.valid_until).getTime() < Date.now()) {
    await supabase
      .from('invoice_financing_offers')
      .update({ status: 'expired', updated_at: new Date().toISOString() })
      .eq('id', offer.id)
    return {
      ok: false,
      code: 'OFFER_EXPIRED',
      message_sv: 'Erbjudandet har gått ut — skapa en ny ansökan för att få ett nytt erbjudande.',
    }
  }

  const provider = getFinancingProvider(application.provider_slug)
  if (!provider || !application.provider_reference) {
    return { ok: false, code: 'PROVIDER_ERROR', message_sv: FINANCING_REQUIRES_AGREEMENT_MESSAGE_SV }
  }

  let payout
  try {
    payout = await provider.acceptOffer(application.provider_reference)
  } catch (err) {
    return { ok: false, code: 'PROVIDER_ERROR', message_sv: (err as Error).message }
  }

  await supabase
    .from('invoice_financing_offers')
    .update({ status: 'accepted', updated_at: new Date().toISOString() })
    .eq('id', offer.id)

  await recordEvent(supabase, {
    companyId: args.companyId,
    applicationId: application.id,
    eventType: 'offer_accepted',
    statusFrom: 'offer_created',
    statusTo: 'accepted',
    payload: { offer_id: offer.id },
    userId: args.userId,
  })

  // Book the payout (non-blocking: financing still advances if no open period).
  const { data: invoiceRow } = await supabase
    .from('invoices')
    .select('id, invoice_number, total')
    .eq('id', application.invoice_id)
    .eq('company_id', args.companyId)
    .maybeSingle()
  const invoiceTag = (invoiceRow as { invoice_number: string | null } | null)?.invoice_number
    ? `faktura ${(invoiceRow as { invoice_number: string }).invoice_number}`
    : 'faktura'

  let journalEntryId: string | null = null
  let bookingWarning: string | null = null
  try {
    const entry = await createFinancingPayoutEntry(supabase, {
      companyId: args.companyId,
      userId: args.userId,
      invoiceId: application.invoice_id,
      invoiceTag,
      invoiceAmount: application.requested_amount,
      payoutAmount: payout.payoutAmount,
      feeAmount: payout.feeAmount,
      recourse: application.recourse,
      payoutDate: payout.payoutDate,
    })
    journalEntryId = entry?.id ?? null
    if (!entry) {
      bookingWarning =
        'Utbetalningen kunde inte bokföras automatiskt (ingen öppen räkenskapsperiod) — bokför manuellt.'
    }
  } catch (err) {
    log.error('financing payout booking failed', { error: (err as Error).message })
    bookingWarning = `Utbetalningen kunde inte bokföras automatiskt: ${(err as Error).message}`
  }

  await supabase.from('invoice_financing_settlements').insert({
    company_id: args.companyId,
    application_id: application.id,
    payout_amount: payout.payoutAmount,
    fee_amount: payout.feeAmount,
    recourse: application.recourse,
    journal_entry_id: journalEntryId,
    settled_at: new Date().toISOString(),
  })

  const { data: updated } = await supabase
    .from('invoice_financing_applications')
    .update({ status: 'paid_out', updated_at: new Date().toISOString() })
    .eq('id', application.id)
    .select('*')
    .single()
  if (updated) application = updated as FinancingApplicationRow

  await recordEvent(supabase, {
    companyId: args.companyId,
    applicationId: application.id,
    eventType: 'paid_out',
    statusFrom: 'accepted',
    statusTo: 'paid_out',
    payload: {
      payout_amount: payout.payoutAmount,
      fee_amount: payout.feeAmount,
      journal_entry_id: journalEntryId,
      booking_warning: bookingWarning,
    },
    userId: args.userId,
  })

  try {
    await eventBus.emit({
      type: 'invoice_financing.paid_out',
      payload: {
        applicationId: application.id,
        invoiceId: application.invoice_id,
        paidOutAmount: payout.payoutAmount,
        userId: args.userId,
        companyId: args.companyId,
      },
    })
  } catch (err) {
    log.warn('invoice_financing.paid_out emit failed', { error: (err as Error).message })
  }

  return {
    ok: true,
    application,
    journalEntryId,
    message_sv: bookingWarning
      ? `Utbetalning genomförd (${payout.payoutAmount.toLocaleString('sv-SE')} kr). ${bookingWarning}`
      : `Utbetalning genomförd: ${payout.payoutAmount.toLocaleString('sv-SE')} kr utbetalt och bokfört.`,
  }
}

export type CancelOutcome =
  | { ok: false; code: 'NOT_FOUND' | 'INVALID_STATE' | 'PROVIDER_ERROR'; message_sv: string }
  | { ok: true; application: FinancingApplicationRow; message_sv: string }

/** Cancel an application that has not yet been accepted/paid out. */
export async function cancelFinancingApplication(
  supabase: SupabaseClient,
  args: { companyId: string; userId: string; applicationId: string },
): Promise<CancelOutcome> {
  const { data: appRow } = await supabase
    .from('invoice_financing_applications')
    .select('*')
    .eq('id', args.applicationId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  if (!appRow) {
    return { ok: false, code: 'NOT_FOUND', message_sv: 'Ansökan kunde inte hittas.' }
  }
  let application = appRow as FinancingApplicationRow

  if (
    FINANCING_TERMINAL_STATUSES.has(application.status) ||
    application.status === 'accepted' ||
    application.status === 'paid_out' ||
    application.status === 'recourse'
  ) {
    return {
      ok: false,
      code: 'INVALID_STATE',
      message_sv: `Ansökan kan inte avbrytas i status ${application.status}.`,
    }
  }

  const provider = getFinancingProvider(application.provider_slug)
  if (provider && application.provider_reference) {
    try {
      await provider.cancelApplication(application.provider_reference)
    } catch (err) {
      return { ok: false, code: 'PROVIDER_ERROR', message_sv: (err as Error).message }
    }
  }

  // Close any open offers.
  await supabase
    .from('invoice_financing_offers')
    .update({ status: 'declined', updated_at: new Date().toISOString() })
    .eq('application_id', application.id)
    .eq('status', 'open')

  const previousStatus = application.status
  const { data: updated } = await supabase
    .from('invoice_financing_applications')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', application.id)
    .select('*')
    .single()
  if (updated) application = updated as FinancingApplicationRow

  await recordEvent(supabase, {
    companyId: args.companyId,
    applicationId: application.id,
    eventType: 'cancelled',
    statusFrom: previousStatus,
    statusTo: 'cancelled',
    userId: args.userId,
  })

  return { ok: true, application, message_sv: 'Ansökan har avbrutits.' }
}
