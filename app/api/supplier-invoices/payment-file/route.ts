import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { generateSupplierPain001, type SupplierPaymentItem } from '@/lib/payments/supplier-pain001'
import { roundOre } from '@/lib/money'

ensureInitialized()

/**
 * POST /api/supplier-invoices/payment-file
 *
 * Generates a pain.001 payment file (leverantörsbetalningar) for a set of
 * approved supplier invoices and records it as a payment_initiation
 * (räkenskapsinformation, BFL 7 kap — retained 7 years, never hard-deleted
 * after export).
 *
 * Flow:
 *   1. Validate the invoices: approved/overdue/partially_paid, SEK,
 *      remaining_amount > 0, supplier has bankgiro/plusgiro/IBAN.
 *   2. Generate pain.001 with SCOR (OCR) remittance where available.
 *   3. Insert payment_initiations row (status=exported) with the file content.
 *   4. Return the file for download. The user uploads it to the bank portal;
 *      the bank's pain.002 answer is posted to
 *      POST /api/payment-initiations/[id]/status-report.
 *
 * The invoices are NOT marked paid here — payment happens when the bank
 * executes the file; the bank transaction is matched against the invoices
 * (existing match/batch flows) which creates the payment vouchers.
 */

const BodySchema = z.object({
  supplier_invoice_ids: z.array(z.string().uuid()).min(1, 'Minst en leverantörsfaktura krävs'),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ogiltigt datum (YYYY-MM-DD)'),
})

const PAYABLE_STATUSES = new Set(['approved', 'overdue', 'partially_paid'])

export const POST = withRouteContext(
  'supplier_invoice.payment_file',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, BodySchema, {
      log,
      operation: 'supplier_invoice.payment_file',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    // Company debtor details.
    const { data: settings } = await supabase
      .from('company_settings')
      .select('company_name, org_number, iban, bic')
      .eq('company_id', companyId)
      .maybeSingle()

    if (!settings?.iban?.trim() || !settings?.bic?.trim()) {
      return errorResponseFromCode('PAYMENT_FILE_COMPANY_BANK_MISSING', log, { requestId })
    }

    const { data: invoices, error: invErr } = await supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, status, currency, remaining_amount, payment_reference, supplier:suppliers(id, name, bankgiro, plusgiro, iban)')
      .eq('company_id', companyId)
      .in('id', body.supplier_invoice_ids)

    if (invErr) {
      return errorResponse(invErr, log, { requestId })
    }

    type Row = {
      id: string
      supplier_invoice_number: string
      status: string
      currency: string
      remaining_amount: number
      payment_reference: string | null
      supplier: { id: string; name: string; bankgiro: string | null; plusgiro: string | null; iban: string | null } | null
    }
    const rows = (invoices ?? []) as unknown as Row[]

    const payable = rows.filter(
      (r) => PAYABLE_STATUSES.has(r.status) && Number(r.remaining_amount) > 0,
    )
    if (payable.length === 0) {
      return errorResponseFromCode('PAYMENT_FILE_NO_INVOICES', log, {
        requestId,
        details: {
          requested: body.supplier_invoice_ids.length,
          payable: 0,
        },
      })
    }

    const nonSek = payable.filter((r) => r.currency !== 'SEK')
    if (nonSek.length > 0) {
      return errorResponseFromCode('PAYMENT_FILE_CURRENCY_UNSUPPORTED', log, {
        requestId,
        details: { invoice_ids: nonSek.map((r) => r.id) },
      })
    }

    const missingBank = payable.filter(
      (r) => !r.supplier?.bankgiro?.trim() && !r.supplier?.plusgiro?.trim() && !r.supplier?.iban?.trim(),
    )
    if (missingBank.length > 0) {
      return errorResponseFromCode('PAYMENT_FILE_SUPPLIER_BANK_MISSING', log, {
        requestId,
        details: {
          suppliers: missingBank.map((r) => ({ invoice_id: r.id, supplier: r.supplier?.name ?? null })),
        },
      })
    }

    const messageId = `NKAP${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    const paymentItems: SupplierPaymentItem[] = payable.map((r, i) => ({
      endToEndId: `${messageId}-TX${String(i + 1).padStart(4, '0')}`,
      creditorName: r.supplier!.name,
      bankgiro: r.supplier!.bankgiro,
      plusgiro: r.supplier!.plusgiro,
      iban: r.supplier!.iban,
      reference: r.payment_reference || r.supplier_invoice_number,
      amount: roundOre(Number(r.remaining_amount)),
      supplierInvoiceId: r.id,
    }))

    let file
    try {
      file = generateSupplierPain001(
        {
          name: settings.company_name || 'Företag',
          orgNumber: settings.org_number || '',
          iban: settings.iban.trim(),
          bic: settings.bic.trim(),
        },
        paymentItems,
        { messageId, paymentDate: body.payment_date },
      )
    } catch (err) {
      log.error('supplier payment file generation failed', err as Error)
      return errorResponseFromCode('PAYMENT_FILE_NO_INVOICES', log, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }

    const { data: initiation, error: insertErr } = await supabase
      .from('payment_initiations')
      .insert({
        company_id: companyId,
        user_id: user.id,
        kind: 'supplier_payment',
        method: 'pain001',
        message_id: messageId,
        status: 'exported',
        payment_date: body.payment_date,
        currency: 'SEK',
        total_amount: file.totalAmount,
        payment_count: file.paymentCount,
        file_name: file.filename,
        file_content: file.xml,
        payments: paymentItems.map((p) => ({
          end_to_end_id: p.endToEndId,
          supplier_invoice_id: p.supplierInvoiceId,
          amount: p.amount,
          creditor_name: p.creditorName,
          reference: p.reference,
          status: 'exported',
        })),
        supplier_invoice_ids: payable.map((r) => r.id),
      })
      .select('id, message_id, status, total_amount, payment_count, file_name, payment_date, created_at')
      .single()

    if (insertErr) {
      log.error('payment_initiations insert failed', insertErr)
      return errorResponse(insertErr, log, { requestId })
    }

    log.info('supplier payment file generated', {
      initiationId: initiation.id,
      messageId,
      paymentCount: file.paymentCount,
      totalAmount: file.totalAmount,
    })

    return NextResponse.json({
      data: {
        initiation,
        file: {
          filename: file.filename,
          content: file.xml,
          content_type: 'application/xml',
        },
      },
    })
  },
  { requireWrite: true },
)
