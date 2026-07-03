/**
 * Peppol / e-invoicing provider abstraction.
 *
 * Sending real Peppol traffic requires an agreement with a certified Peppol
 * Access Point (Pagero, InExchange, Crediflow, Qvalia, …). Nordklart is
 * TECHNICALLY PREPARED: BIS Billing 3 generation + validation, participant
 * lookup, the delivery data model and the send/receive flows all run against
 * this interface. Until an access-point agreement is configured, the sandbox
 * provider covers demo/test and the UI states "kräver avtal med
 * Peppol-accesspunkt".
 */

export type EInvoiceDeliveryStatus =
  | 'not_configured'
  | 'ready'
  | 'validation_failed'
  | 'participant_not_found'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'rejected'
  | 'received'
  | 'booked'
  | 'archived'

export interface EInvoiceValidationIssue {
  /** BIS Billing 3 / Sweden CIUS rule id when applicable (e.g. SE-R-005). */
  rule: string
  message_sv: string
}

export interface ParticipantLookupResult {
  found: boolean
  participantId: string
  /** Receiving capabilities (document types) when found. */
  capabilities?: string[]
  error?: string
}

export interface SendEInvoiceResult {
  status: Extract<EInvoiceDeliveryStatus, 'sent' | 'delivered' | 'rejected'>
  providerReference: string | null
  error?: string
}

export interface EInvoiceProvider {
  readonly id: 'sandbox' | 'none' | string
  readonly mode: 'sandbox' | 'production'
  /** Validate a UBL document against BIS Billing 3 + Sweden CIUS rules. */
  validateInvoice(ublXml: string): Promise<EInvoiceValidationIssue[]>
  /** SMP participant lookup — can the participant receive BIS Billing 3? */
  lookupParticipant(participantId: string): Promise<ParticipantLookupResult>
  /** Hand the document to the access point. */
  sendInvoice(args: {
    ublXml: string
    participantId: string
    invoiceNumber: string
  }): Promise<SendEInvoiceResult>
  /** Poll delivery status by provider reference. */
  getDeliveryStatus(providerReference: string): Promise<EInvoiceDeliveryStatus>
}

/** Peppol participant identifier: <scheme>:<value>, e.g. 0007:5566778899. */
const PEPPOL_ID_RE = /^\d{4}:[A-Za-z0-9][A-Za-z0-9\-.]{1,48}$/

export function isValidPeppolId(id: string): boolean {
  return PEPPOL_ID_RE.test(id.trim())
}

/** Build the Swedish org-number Peppol id (scheme 0007). */
export function peppolIdFromOrgNumber(orgNumber: string): string | null {
  const digits = orgNumber.replace(/\D/g, '')
  if (digits.length !== 10) return null
  return `0007:${digits}`
}
