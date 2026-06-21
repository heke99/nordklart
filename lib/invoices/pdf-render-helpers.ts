/**
 * Shared helpers for invoice PDF render call sites.
 *
 * Wraps `brandingFromCompanySettings` so every PDF-rendering route gets a
 * consistent branding object. `buildSwishQrDataUrl` is intentionally a safe
 * no-op in Nordklart for now: the PDF template has the Swish number row, but
 * QR rendering is not enabled as a product feature yet.
 */

import type { CompanySettings, Invoice } from '@/types'
import { brandingFromCompanySettings, type InvoiceBranding } from '@/lib/invoices/pdf-template'

export interface InvoicePdfRenderExtras {
  branding: InvoiceBranding
}

export function prepareInvoicePdfRender(company: CompanySettings): InvoicePdfRenderExtras {
  return { branding: brandingFromCompanySettings(company) }
}

export async function buildSwishQrDataUrl(
  _company: CompanySettings,
  _invoice: Invoice,
): Promise<string | null> {
  return null
}
