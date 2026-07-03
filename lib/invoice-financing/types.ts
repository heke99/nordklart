/**
 * Invoice financing (fakturaförsäljning/fakturabelåning) provider layer.
 *
 * A financing provider receives an application for a SENT customer invoice,
 * runs a credit check, and responds with an offer (or rejection / request
 * for more information). When the company accepts the offer, the provider
 * pays out and the receivable is either sold (non-recourse) or pledged
 * (recourse). Production providers REQUIRE an external agreement; the
 * sandbox provider ships enabled so the full flow is testable end to end.
 */

export type FinancingApplicationStatus =
  | 'submitted'
  | 'needs_more_info'
  | 'offer_created'
  | 'accepted'
  | 'rejected'
  | 'paid_out'
  | 'settled'
  | 'recourse'
  | 'cancelled'

export interface FinancingApplicationInput {
  applicationId: string
  companyId: string
  invoice: {
    id: string
    invoice_number: string | null
    total: number
    currency: string
    due_date: string
  }
  customer: {
    name: string
    org_number: string | null
  }
  requestedAmount: number
  recourse: boolean
}

export interface FinancingOfferTerms {
  offeredAmount: number
  feePercent: number
  feeAmount: number
  payoutAmount: number
  recourse: boolean
  validUntil: string | null
  providerReference: string
}

export type SubmitApplicationResult =
  | { status: 'offer_created'; offer: FinancingOfferTerms }
  | { status: 'needs_more_info'; message_sv: string; providerReference: string }
  | { status: 'rejected'; message_sv: string; providerReference: string }

export interface AcceptOfferResult {
  status: 'paid_out'
  payoutAmount: number
  feeAmount: number
  payoutDate: string
  providerReference: string
}

export interface InvoiceFinancingProvider {
  slug: string
  mode: 'sandbox' | 'production'
  /** Submit an application; the provider answers synchronously or via webhook. */
  submitApplication(input: FinancingApplicationInput): Promise<SubmitApplicationResult>
  /** Accept an open offer — triggers the payout. */
  acceptOffer(providerReference: string): Promise<AcceptOfferResult>
  /** Cancel an application that has not been accepted. */
  cancelApplication(providerReference: string): Promise<void>
}

/** Terminal statuses — no further transitions allowed. */
export const FINANCING_TERMINAL_STATUSES: ReadonlySet<FinancingApplicationStatus> = new Set([
  'rejected',
  'cancelled',
  'settled',
])

export const FINANCING_REQUIRES_AGREEMENT_MESSAGE_SV =
  'Fakturafinansiering i produktion kräver ett avtal med en finansieringspartner. ' +
  'Nordklart är tekniskt förberett — kontakta supporten för att aktivera. ' +
  'I testläge kan flödet provas mot sandbox-finansiären.'
