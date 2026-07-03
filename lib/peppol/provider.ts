import crypto from 'crypto'
import type {
  EInvoiceProvider,
  EInvoiceValidationIssue,
  EInvoiceDeliveryStatus,
  ParticipantLookupResult,
  SendEInvoiceResult,
} from './types'
import { isValidPeppolId } from './types'

/**
 * E-invoice provider resolution.
 *
 * Production Peppol traffic requires an agreement with a certified access
 * point — configured via env:
 *
 *   PEPPOL_PROVIDER=sandbox   (default outside production)
 *   PEPPOL_PROVIDER=none      (not configured — flows return
 *                              'not_configured' with the "kräver avtal med
 *                              Peppol-accesspunkt" message)
 *
 * A real access-point implementation (Pagero/InExchange/Qvalia/…) plugs in
 * as another EInvoiceProvider implementation without touching the flows.
 */

export type PeppolReadiness = 'sandbox_ready' | 'requires_agreement'

export function getPeppolReadiness(): PeppolReadiness {
  const provider = process.env.PEPPOL_PROVIDER
  if (provider === 'none') return 'requires_agreement'
  if (provider === 'sandbox') return 'sandbox_ready'
  // Default: sandbox in non-production, agreement-required in production.
  return process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_SELF_HOSTED !== 'true'
    ? 'requires_agreement'
    : 'sandbox_ready'
}

export const PEPPOL_REQUIRES_AGREEMENT_MESSAGE_SV =
  'E-faktura via Peppol kräver ett avtal med en certifierad Peppol-accesspunkt ' +
  '(t.ex. Pagero, InExchange eller Qvalia). Nordklart är tekniskt förberett — ' +
  'kontakta supporten för att aktivera. Tills dess skickas fakturan som PDF via e-post.'

export function getEInvoiceProvider(): EInvoiceProvider | null {
  return getPeppolReadiness() === 'sandbox_ready' ? sandboxEInvoiceProvider : null
}

// ── Sandbox provider ─────────────────────────────────────────────────────────

/** In-memory delivery statuses so getDeliveryStatus is deterministic. */
const sandboxDeliveries = new Map<string, EInvoiceDeliveryStatus>()

/**
 * Deterministic sandbox: validation delegates to structural checks on the
 * XML, participant lookup succeeds for every well-formed Peppol id EXCEPT
 * the reserved 0007:0000000000 (yields participant_not_found — testable
 * failure path), sends succeed and flip to delivered on the first status
 * poll.
 */
export const sandboxEInvoiceProvider: EInvoiceProvider = {
  id: 'sandbox',
  mode: 'sandbox',

  async validateInvoice(ublXml: string): Promise<EInvoiceValidationIssue[]> {
    const issues: EInvoiceValidationIssue[] = []
    if (!ublXml.includes('urn:fdc:peppol.eu:2017:poacc:billing:3.0')) {
      issues.push({ rule: 'BIS-3', message_sv: 'Dokumentet är inte ett Peppol BIS Billing 3-dokument (CustomizationID saknas).' })
    }
    if (!ublXml.includes('<cac:InvoiceLine>')) {
      issues.push({ rule: 'BG-25', message_sv: 'Fakturan saknar rader.' })
    }
    if (!ublXml.includes('<cac:LegalMonetaryTotal>')) {
      issues.push({ rule: 'BG-22', message_sv: 'Belopps-sektionen (LegalMonetaryTotal) saknas.' })
    }
    return issues
  },

  async lookupParticipant(participantId: string): Promise<ParticipantLookupResult> {
    if (!isValidPeppolId(participantId)) {
      return { found: false, participantId, error: 'Ogiltigt Peppol-id-format.' }
    }
    if (participantId === '0007:0000000000') {
      return { found: false, participantId, error: 'Mottagaren är inte registrerad i Peppol (SMP-uppslag gav ingen träff).' }
    }
    return {
      found: true,
      participantId,
      capabilities: ['urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1'],
    }
  },

  async sendInvoice(args): Promise<SendEInvoiceResult> {
    const ref = `sandbox-${crypto.randomUUID()}`
    sandboxDeliveries.set(ref, 'sent')
    return { status: 'sent', providerReference: ref }
  },

  async getDeliveryStatus(providerReference: string): Promise<EInvoiceDeliveryStatus> {
    const current = sandboxDeliveries.get(providerReference)
    if (!current) return 'rejected'
    if (current === 'sent') {
      sandboxDeliveries.set(providerReference, 'delivered')
      return 'delivered'
    }
    return current
  },
}

/** Test hook. */
export function __resetSandboxEInvoiceDeliveries(): void {
  sandboxDeliveries.clear()
}
