import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import { generateOcrReference } from '@/lib/bankgiro/luhn'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type { Customer, Invoice, InvoiceItem } from '@/types'
import {
  generateUblInvoice,
  validateForPeppol,
  type UblInvoiceInput,
  type UblLine,
} from './ubl-generator'
import {
  getEInvoiceProvider,
  PEPPOL_REQUIRES_AGREEMENT_MESSAGE_SV,
} from './provider'
import type { EInvoiceValidationIssue, EInvoiceDeliveryStatus } from './types'

const log = createLogger('peppol-service')

export interface SendEInvoiceOutcome {
  status: EInvoiceDeliveryStatus
  deliveryId: string | null
  issues: EInvoiceValidationIssue[]
  message_sv: string
}

/** Map an invoice line to the BIS VAT category. */
function vatCategoryFor(
  invoice: Pick<Invoice, 'vat_treatment' | 'sale_type'>,
  vatRate: number,
): UblLine['vatCategory'] {
  if (vatRate > 0) return 'S'
  switch (invoice.vat_treatment) {
    case 'reverse_charge':
      return invoice.sale_type === 'goods' ? 'K' : 'AE'
    case 'export':
      return 'G'
    case 'exempt':
      return 'E'
    default:
      return 'Z'
  }
}

/**
 * Send a sent customer invoice as a Peppol BIS Billing 3 e-invoice.
 *
 * Every attempt creates an e_invoice_deliveries row — including failed
 * validation and the not-configured case — so the UI always has a status
 * trail. PDF/email remains the fallback path (the caller decides).
 */
export async function sendInvoiceAsEInvoice(
  supabase: SupabaseClient,
  args: { companyId: string; userId: string; invoiceId: string },
): Promise<SendEInvoiceOutcome> {
  const { data: invoiceRow, error: invErr } = await supabase
    .from('invoices')
    .select('*, items:invoice_items(*), customer:customers(*)')
    .eq('id', args.invoiceId)
    .eq('company_id', args.companyId)
    .maybeSingle()

  if (invErr || !invoiceRow) {
    return {
      status: 'validation_failed',
      deliveryId: null,
      issues: [{ rule: 'NOT_FOUND', message_sv: 'Fakturan kunde inte hittas.' }],
      message_sv: 'Fakturan kunde inte hittas.',
    }
  }

  const invoice = invoiceRow as unknown as Invoice & { items: InvoiceItem[]; customer: Customer | null }
  const customer = invoice.customer

  if (!invoice.invoice_number || invoice.status === 'draft') {
    return {
      status: 'validation_failed',
      deliveryId: null,
      issues: [{ rule: 'STATUS', message_sv: 'Endast utställda fakturor (med fakturanummer) kan skickas som e-faktura.' }],
      message_sv: 'Endast utställda fakturor kan skickas som e-faktura.',
    }
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name, org_number, vat_number, f_skatt, address_line1, postal_code, city, bankgiro, plusgiro, iban, bic')
    .eq('company_id', args.companyId)
    .maybeSingle()

  const peppolId = (customer as (Customer & { peppol_id?: string | null }) | null)?.peppol_id ?? ''

  const lines: UblLine[] = (invoice.items ?? [])
    .filter((item) => item.line_type !== 'text')
    .map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unitPriceExclVat: item.unit_price,
      lineTotalExclVat: roundOre(item.line_total),
      vatRatePercent: item.vat_rate ?? 0,
      vatCategory: vatCategoryFor(invoice, item.vat_rate ?? 0),
    }))

  const ublInput: UblInvoiceInput = {
    invoiceNumber: invoice.invoice_number,
    issueDate: invoice.invoice_date,
    dueDate: invoice.due_date,
    currency: invoice.currency,
    typeCode: invoice.credited_invoice_id ? 381 : 380,
    buyerReference: invoice.your_reference,
    ocrReference: invoice.invoice_number ? generateOcrReference(invoice.invoice_number) : null,
    note: invoice.reverse_charge_text,
    seller: {
      name: settings?.company_name ?? '',
      orgNumber: settings?.org_number ?? '',
      vatNumber: settings?.vat_number ?? null,
      fSkatt: settings?.f_skatt ?? false,
      addressLine1: settings?.address_line1 ?? null,
      postalCode: settings?.postal_code ?? null,
      city: settings?.city ?? null,
      countryCode: 'SE',
      bankgiro: settings?.bankgiro ?? null,
      plusgiro: settings?.plusgiro ?? null,
      iban: settings?.iban ?? null,
      bic: settings?.bic ?? null,
    },
    buyer: {
      name: customer?.name ?? '',
      peppolId,
      orgNumber: customer?.org_number ?? null,
      vatNumber: customer?.vat_number ?? null,
      addressLine1: customer?.address_line1 ?? null,
      postalCode: customer?.postal_code ?? null,
      city: customer?.city ?? null,
      countryCode: customer?.country === 'Sweden' || !customer?.country ? 'SE' : customer.country.slice(0, 2).toUpperCase(),
    },
    lines,
  }

  const insertDelivery = async (fields: {
    status: EInvoiceDeliveryStatus
    ublXml?: string | null
    validationErrors?: EInvoiceValidationIssue[]
    providerReference?: string | null
    errorMessage?: string | null
    provider: string
  }): Promise<string | null> => {
    const { data } = await supabase
      .from('e_invoice_deliveries')
      .insert({
        company_id: args.companyId,
        invoice_id: args.invoiceId,
        direction: 'outbound',
        provider: fields.provider,
        participant_id: peppolId || null,
        status: fields.status,
        ubl_xml: fields.ublXml ?? null,
        validation_errors: fields.validationErrors ?? [],
        provider_reference: fields.providerReference ?? null,
        error_message: fields.errorMessage ?? null,
        created_by: args.userId,
      })
      .select('id')
      .single()
    return (data as { id: string } | null)?.id ?? null
  }

  // 1. Provider configured?
  const provider = getEInvoiceProvider()
  if (!provider) {
    const deliveryId = await insertDelivery({
      status: 'not_configured',
      provider: 'none',
      errorMessage: PEPPOL_REQUIRES_AGREEMENT_MESSAGE_SV,
    })
    return {
      status: 'not_configured',
      deliveryId,
      issues: [],
      message_sv: PEPPOL_REQUIRES_AGREEMENT_MESSAGE_SV,
    }
  }

  // 2. Local BIS Billing 3 + Sweden CIUS validation.
  const issues = validateForPeppol(ublInput)
  if (issues.length > 0) {
    const deliveryId = await insertDelivery({
      status: 'validation_failed',
      provider: provider.id,
      validationErrors: issues,
    })
    return {
      status: 'validation_failed',
      deliveryId,
      issues,
      message_sv: `Fakturan klarar inte e-fakturavalideringen (${issues.length} fel). Åtgärda punkterna och försök igen.`,
    }
  }

  // 3. SMP participant lookup.
  const lookup = await provider.lookupParticipant(peppolId)
  if (!lookup.found) {
    const deliveryId = await insertDelivery({
      status: 'participant_not_found',
      provider: provider.id,
      errorMessage: lookup.error ?? 'Mottagaren är inte registrerad i Peppol.',
    })
    return {
      status: 'participant_not_found',
      deliveryId,
      issues: [],
      message_sv: lookup.error ?? 'Mottagaren är inte registrerad i Peppol — skicka som PDF via e-post i stället.',
    }
  }

  // 4. Generate + provider-side validation + send.
  const ublXml = generateUblInvoice(ublInput)
  const providerIssues = await provider.validateInvoice(ublXml)
  if (providerIssues.length > 0) {
    const deliveryId = await insertDelivery({
      status: 'validation_failed',
      provider: provider.id,
      ublXml,
      validationErrors: providerIssues,
    })
    return {
      status: 'validation_failed',
      deliveryId,
      issues: providerIssues,
      message_sv: 'Accesspunktens validering avvisade fakturan.',
    }
  }

  const sent = await provider.sendInvoice({
    ublXml,
    participantId: peppolId,
    invoiceNumber: invoice.invoice_number,
  })

  const deliveryId = await insertDelivery({
    status: sent.status,
    provider: provider.id,
    ublXml,
    providerReference: sent.providerReference,
    errorMessage: sent.error ?? null,
  })

  if (sent.status !== 'rejected' && deliveryId) {
    try {
      await eventBus.emit({
        type: 'peppol_invoice.sent',
        payload: {
          invoiceId: args.invoiceId,
          deliveryId,
          participantId: peppolId,
          status: sent.status,
          userId: args.userId,
          companyId: args.companyId,
        },
      })
    } catch (err) {
      log.warn('peppol_invoice.sent emit failed', { deliveryId, error: (err as Error).message })
    }
  }

  return {
    status: sent.status,
    deliveryId,
    issues: [],
    message_sv:
      sent.status === 'rejected'
        ? `E-fakturan avvisades: ${sent.error ?? 'okänt fel'}`
        : `E-fakturan har skickats via Peppol (${provider.mode === 'sandbox' ? 'sandbox-läge' : 'produktion'}).`,
  }
}
