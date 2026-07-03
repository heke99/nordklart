import crypto from 'crypto'
import { roundOre } from '@/lib/money'
import type {
  AcceptOfferResult,
  FinancingApplicationInput,
  InvoiceFinancingProvider,
  SubmitApplicationResult,
} from './types'

/**
 * Provider resolution for invoice financing.
 *
 * Production factoring requires an agreement with a financing partner —
 * configured via env:
 *
 *   INVOICE_FINANCING_PROVIDER=sandbox   (default outside production)
 *   INVOICE_FINANCING_PROVIDER=none      (not configured — flows return
 *                                         'requires_agreement')
 *
 * A real partner implementation plugs in as another
 * InvoiceFinancingProvider without touching the flows.
 */

export type FinancingReadiness = 'sandbox_ready' | 'requires_agreement'

export function getFinancingReadiness(): FinancingReadiness {
  const provider = process.env.INVOICE_FINANCING_PROVIDER
  if (provider === 'none') return 'requires_agreement'
  if (provider === 'sandbox') return 'sandbox_ready'
  return process.env.NODE_ENV === 'production' && process.env.NEXT_PUBLIC_SELF_HOSTED !== 'true'
    ? 'requires_agreement'
    : 'sandbox_ready'
}

export function getFinancingProvider(slug: string): InvoiceFinancingProvider | null {
  if (slug === 'sandbox' && getFinancingReadiness() === 'sandbox_ready') {
    return sandboxFinancingProvider
  }
  return null
}

// ── Sandbox provider ─────────────────────────────────────────────────────────

const SANDBOX_FEE_PERCENT = 3
const SANDBOX_OFFER_VALIDITY_DAYS = 14

interface SandboxState {
  status: 'offer_created' | 'accepted' | 'cancelled'
  payoutAmount: number
  feeAmount: number
}

/** In-memory application states keyed by provider reference. */
const sandboxApplications = new Map<string, SandboxState>()

/**
 * Deterministic sandbox for tests + demo:
 *  - customer org number ending in '00' → needs_more_info (testable path)
 *  - customer name containing 'avslag'  → rejected (testable path)
 *  - everything else → immediate offer at 3% fee, valid 14 days
 *  - acceptOffer pays out same-day
 */
export const sandboxFinancingProvider: InvoiceFinancingProvider = {
  slug: 'sandbox',
  mode: 'sandbox',

  async submitApplication(input: FinancingApplicationInput): Promise<SubmitApplicationResult> {
    const ref = `sandbox-fin-${crypto.randomUUID()}`

    if (input.customer.org_number?.endsWith('00')) {
      return {
        status: 'needs_more_info',
        message_sv:
          'Finansiären behöver kompletterande uppgifter om kunden (testläge: organisationsnummer som slutar på 00 triggar detta svar).',
        providerReference: ref,
      }
    }
    if (input.customer.name.toLowerCase().includes('avslag')) {
      return {
        status: 'rejected',
        message_sv:
          'Finansiären avslog ansökan efter kreditprövning av kunden (testläge: kundnamn som innehåller "avslag" triggar detta svar).',
        providerReference: ref,
      }
    }

    const feeAmount = roundOre(input.requestedAmount * (SANDBOX_FEE_PERCENT / 100))
    const payoutAmount = roundOre(input.requestedAmount - feeAmount)
    const validUntil = new Date(Date.now() + SANDBOX_OFFER_VALIDITY_DAYS * 86_400_000).toISOString()

    sandboxApplications.set(ref, { status: 'offer_created', payoutAmount, feeAmount })

    return {
      status: 'offer_created',
      offer: {
        offeredAmount: roundOre(input.requestedAmount),
        feePercent: SANDBOX_FEE_PERCENT,
        feeAmount,
        payoutAmount,
        recourse: input.recourse,
        validUntil,
        providerReference: ref,
      },
    }
  },

  async acceptOffer(providerReference: string): Promise<AcceptOfferResult> {
    const state = sandboxApplications.get(providerReference)
    if (!state || state.status !== 'offer_created') {
      throw new Error('Erbjudandet finns inte eller är inte längre öppet hos finansiären.')
    }
    sandboxApplications.set(providerReference, { ...state, status: 'accepted' })
    return {
      status: 'paid_out',
      payoutAmount: state.payoutAmount,
      feeAmount: state.feeAmount,
      payoutDate: new Date().toISOString().slice(0, 10),
      providerReference,
    }
  },

  async cancelApplication(providerReference: string): Promise<void> {
    const state = sandboxApplications.get(providerReference)
    if (state && state.status === 'accepted') {
      throw new Error('Ansökan är redan accepterad och utbetald — den kan inte avbrytas.')
    }
    if (state) {
      sandboxApplications.set(providerReference, { ...state, status: 'cancelled' })
    }
  },
}

/** Test hook. */
export function __resetSandboxFinancingApplications(): void {
  sandboxApplications.clear()
}
