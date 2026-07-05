import type { Customer, CompanySettings, Invoice } from '@/types'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailSubject,
  generateInvoiceEmailText,
} from '@/lib/email/invoice-templates'
import type { SendEmailOptions } from '@/lib/email/service'

/**
 * Shared composition for the four invoice-send paths (dashboard route,
 * v1 API route, pending-operation commit, recurring schedule).
 *
 * The flow control around them differs deliberately (guards, dry-run,
 * error envelopes), but the attachment filename and the email payload must
 * never drift between paths — one email per invoice, identical regardless
 * of which surface sent it.
 */

/** Attachment filename by document type / credit-note state. */
export function invoiceEmailFilename(invoice: Pick<Invoice, 'invoice_number' | 'document_type' | 'credited_invoice_id'>): string {
  if (invoice.credited_invoice_id) return `kreditfaktura-${invoice.invoice_number}.pdf`
  const docType = invoice.document_type || 'invoice'
  if (docType === 'proforma') return `proformafaktura-${invoice.invoice_number}.pdf`
  if (docType === 'delivery_note') return `foljesedel-${invoice.invoice_number}.pdf`
  return `faktura-${invoice.invoice_number}.pdf`
}

export interface InvoiceEmailPayloadInput {
  invoice: Invoice
  customer: Customer
  company: CompanySettings
  companyId: string
  pdfBuffer: Buffer
  /** Customer recipient — must be verified non-null by the caller's guards. */
  to: string
  ccAddress?: string | null
}

/** Complete SendEmailOptions for an invoice send, including audit context. */
export function buildInvoiceEmailOptions(input: InvoiceEmailPayloadInput): SendEmailOptions {
  const { invoice, customer, company, companyId, pdfBuffer, to, ccAddress } = input
  const emailData = { invoice, customer, company }
  return {
    to,
    cc: ccAddress || undefined,
    subject: generateInvoiceEmailSubject(emailData),
    html: generateInvoiceEmailHtml(emailData),
    text: generateInvoiceEmailText(emailData),
    replyTo: company.email || undefined,
    fromName: company.company_name || undefined,
    attachments: [
      {
        filename: invoiceEmailFilename(invoice),
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
    // Audit only — no dedupe key. Deliberate re-sends (customer lost the
    // email) are a supported flow and must not be suppressed.
    context: {
      companyId,
      templateKey: 'invoice.send',
    },
  }
}
