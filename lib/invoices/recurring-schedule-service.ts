/**
 * Recurring invoice schedule service.
 *
 * Two public functions:
 *  - executeRecurringSchedule: spawn one invoice from a schedule, optionally
 *    sending it. Used by the daily cron and by a manual "run now" admin
 *    action.
 *  - computeNextRunDate: pure date helper. Given today + day_of_month, return
 *    the next date the schedule should run. Day-of-month values >28 are
 *    clamped to the last day of shorter months; the schedule keeps its
 *    original day_of_month so it jumps back in months that have it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'
import {
  applyPeriodPlaceholders,
  billingPeriod,
  formatPeriodSv,
  lineAppliesToPeriod,
  type BillingPeriod,
} from '@/lib/invoices/recurring-period'
import { ensureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { createInvoiceJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { renderToBuffer } from '@react-pdf/renderer'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { prepareInvoicePdfRender } from '@/lib/invoices/pdf-render-helpers'
import { getEmailService } from '@/lib/email/service'
import { isValidEmailAddress } from '@/lib/email/validate'
import { buildInvoiceEmailOptions, invoiceEmailFilename } from '@/lib/invoices/send-invoice-email'
import { uploadDocument } from '@/lib/core/documents/document-service'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { createLogger } from '@/lib/logger'
import type {
  Invoice,
  InvoiceItem,
  Customer,
  CompanySettings,
  RecurringInvoiceSchedule,
  RecurringInvoiceScheduleItem,
} from '@/types'

const log = createLogger('invoices/recurring-schedule-service')

export interface ExecuteResult {
  invoiceId: string
  invoiceNumber: string | null
  autoSent: boolean
  warning: string | null
  /** Schedule lines that went onto this invoice (for remaining_occurrences). */
  usedItemIds: string[]
  /** Calendar period the invoice covers. */
  period: BillingPeriod
}

/** A run that had nothing to invoice (no line applies to its period). Not a failure. */
export class RecurringRunSkipped extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RecurringRunSkipped'
  }
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Last day of the month for the given year/month (1-indexed month).
 * Used to clamp day_of_month values >28 in shorter months.
 */
function lastDayOfMonth(year: number, monthIndex0: number): number {
  // Day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate()
}

/**
 * Compute the next run date for a schedule given a reference date and the
 * stored day_of_month. The reference is always interpreted in UTC to avoid
 * timezone surprises around the day boundary in Vercel cron.
 *
 * Rules:
 *  - If reference is the same as a valid day_of_month occurrence, returns
 *    NEXT month's occurrence (callers compute the FIRST run via
 *    computeInitialRunDate).
 *  - Day 29-31 in shorter months clamps to that month's last day.
 *  - The schedule's stored day_of_month is unchanged — caller passes it in.
 */
export function computeNextRunDate(reference: Date, dayOfMonth: number): string {
  if (dayOfMonth < 1 || dayOfMonth > 31) {
    throw new Error(`invalid day_of_month: ${dayOfMonth}`)
  }
  const refY = reference.getUTCFullYear()
  const refM = reference.getUTCMonth()
  // Advance to the next month.
  const nextM = refM + 1
  const nextYear = refY + Math.floor(nextM / 12)
  const nextMonth = ((nextM % 12) + 12) % 12
  const clamped = Math.min(dayOfMonth, lastDayOfMonth(nextYear, nextMonth))
  const yyyy = nextYear.toString().padStart(4, '0')
  const mm = (nextMonth + 1).toString().padStart(2, '0')
  const dd = clamped.toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Compute the initial next_run_date when a schedule is created.
 * - If start_date is given, use it.
 * - Else, if today's day-of-month <= schedule day_of_month (clamped to this
 *   month's last day), pick this month's occurrence.
 * - Otherwise pick next month's occurrence.
 */
export function computeInitialRunDate(
  today: Date,
  dayOfMonth: number,
  startDate?: string,
): string {
  if (startDate) return startDate
  if (dayOfMonth < 1 || dayOfMonth > 31) {
    throw new Error(`invalid day_of_month: ${dayOfMonth}`)
  }
  const y = today.getUTCFullYear()
  const m = today.getUTCMonth()
  const todayDay = today.getUTCDate()
  const thisMonthDay = Math.min(dayOfMonth, lastDayOfMonth(y, m))
  if (todayDay <= thisMonthDay) {
    const yyyy = y.toString().padStart(4, '0')
    const mm = (m + 1).toString().padStart(2, '0')
    const dd = thisMonthDay.toString().padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
  }
  return computeNextRunDate(today, dayOfMonth)
}

/**
 * Spawn one invoice from a schedule. Always creates the invoice; auto_send
 * additionally renders + emails + flips status + creates JE + archives PDF.
 *
 * Idempotency: caller must check schedule.last_run_at >= today before calling
 * to prevent double-spawn on cron retries within the same UTC day.
 */
export async function executeRecurringSchedule(
  supabase: SupabaseClient,
  schedule: RecurringInvoiceSchedule & { items: RecurringInvoiceScheduleItem[] },
  today: Date = new Date(),
  runDate?: string,
): Promise<ExecuteResult> {
  const opLog = log.child({ scheduleId: schedule.id, companyId: schedule.company_id })

  // 1. Load customer to resolve VAT rules.
  const { data: customer, error: customerErr } = await supabase
    .from('customers')
    .select('*')
    .eq('id', schedule.customer_id)
    .eq('company_id', schedule.company_id)
    .single<Customer>()

  if (customerErr || !customer) {
    throw new Error(`customer not found for schedule ${schedule.id}`)
  }

  // 2. The period this run covers, and the lines that apply to it.
  const invoiceDate = isoDay(today)
  const period = billingPeriod(
    runDate ?? invoiceDate,
    schedule.interval_months ?? 1,
    schedule.billing_timing ?? 'current_period',
  )
  const items = (schedule.items || [])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .filter((item) => lineAppliesToPeriod(item, period))
  if (items.length === 0) {
    throw new RecurringRunSkipped(
      `Inga fakturarader gäller för perioden ${formatPeriodSv(period)} — ingen faktura skapades.`,
    )
  }

  // 3. Dates: invoice_date = the run day, due_date = +payment_terms_days.
  const due = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  due.setUTCDate(due.getUTCDate() + schedule.payment_terms_days)
  const dueDate = due.toISOString().slice(0, 10)

  // 4. Amounts, VAT treatment and line rows through the same builder as a
  //    manual invoice: customer VAT rules, a company that is not VAT
  //    registered (no output VAT), reverse charge requiring the buyer's VAT
  //    number, revenue-account overrides and currency conversion all behave
  //    exactly as when the user creates the invoice by hand.
  const built = await buildInvoiceWriteData({
    supabase,
    companyId: schedule.company_id,
    customer,
    documentType: 'invoice',
    input: {
      customer_id: schedule.customer_id,
      invoice_date: invoiceDate,
      due_date: dueDate,
      delivery_date: null,
      currency: schedule.currency,
      sale_type: schedule.sale_type ?? 'services',
      your_reference: schedule.your_reference ?? undefined,
      our_reference: schedule.our_reference ?? undefined,
      notes: schedule.notes ?? undefined,
      items: items.map((item) => ({
        line_type: 'product' as const,
        description: applyPeriodPlaceholders(item.description, period),
        quantity: Number(item.quantity),
        unit: item.unit,
        unit_price: Number(item.unit_price),
        // undefined = the customer's default rate (resolved by the builder).
        vat_rate: item.vat_rate != null ? Number(item.vat_rate) : undefined,
        article_id: item.article_id ?? null,
        revenue_account: item.revenue_account ?? null,
      })),
    },
  })
  if (!built.ok) {
    if ('code' in built) {
      throw new Error(`invoice validation failed (${built.code}): ${JSON.stringify(built.details ?? {})}`)
    }
    throw new Error(`invoice validation failed: ${String((built.dbError as { message?: string })?.message ?? built.dbError)}`)
  }

  // 5. Insert invoice header.
  const { data: invoice, error: invoiceError } = await supabase
    .from('invoices')
    .insert({
      ...built.invoiceFields,
      user_id: schedule.user_id,
      company_id: schedule.company_id,
      invoice_number: null,
      period_start: period.start,
      period_end: period.end,
    })
    .select()
    .single()

  if (invoiceError || !invoice) {
    throw new Error(`failed to insert invoice from schedule: ${invoiceError?.message ?? 'unknown'}`)
  }

  // 6. Insert items.
  const itemRows = built.items.map((row) => ({ ...row, invoice_id: invoice.id }))
  const { error: itemsError } = await supabase.from('invoice_items').insert(itemRows)
  if (itemsError) {
    // Hard-delete is safe here only because step 5 inserted invoice_number: null
    // — no F-series slot has been consumed yet (step 7 calls ensureInvoiceNumber).
    // Once a number is assigned, the soft-cancel path in step 7 must be used to
    // preserve the sequence per BFL 5 kap 6§ / ML 17 kap 24§.
    await supabase.from('invoices').delete().eq('id', invoice.id)
    throw new Error(`failed to insert invoice items: ${itemsError.message}`)
  }
  const usedItemIds = items.map((item) => item.id)

  // 7a. Preflight PDF for auto-send BEFORE consuming an F-series number —
  //     mirrors the manual send route. If the PDF pipeline is broken the
  //     invoice stays an UNNUMBERED draft (no sequence slot wasted, ML 17
  //     kap 24§) and the schedule gets a clear warning; a later manual send
  //     allocates the number once the PDF renders again.
  if (schedule.auto_send) {
    const { data: preflightCompany } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', schedule.company_id)
      .single<CompanySettings>()

    if (preflightCompany) {
      try {
        const { branding } = prepareInvoicePdfRender(preflightCompany)
        await renderToBuffer(
          InvoicePDF({
            invoice: { ...(invoice as Invoice), invoice_number: 'F-PREVIEW', status: 'sent' as const },
            customer,
            items: itemRows as unknown as InvoiceItem[],
            company: preflightCompany,
            branding,
          }),
        )
      } catch (err) {
        opLog.error('preflight PDF render failed for recurring auto-send — invoice kept unnumbered', err as Error, {
          invoiceId: invoice.id,
        })
        await eventBus.emit({
          type: 'invoice.created',
          payload: {
            invoice: { ...(invoice as Invoice), items: itemRows as unknown as InvoiceItem[] },
            companyId: schedule.company_id,
            userId: schedule.user_id,
          },
        })
        return {
          invoiceId: invoice.id,
          invoiceNumber: null,
          autoSent: false,
          usedItemIds,
          period,
          warning: 'PDF-genereringen misslyckades — inget e-postmeddelande skickades. Fakturan finns som utkast utan fakturanummer och kan skickas manuellt.',
        }
      }
    }
  }

  // 7b. Allocate F-series number.
  try {
    await ensureInvoiceNumber(supabase, schedule.company_id, invoice as Invoice)
  } catch (err) {
    // Soft-cancel to preserve the F-series sequence (ML 17 kap 24§).
    await supabase
      .from('invoices')
      .update({ status: 'cancelled' })
      .eq('id', invoice.id)
      .eq('company_id', schedule.company_id)
      .eq('status', 'draft')
    throw new Error(
      `failed to assign invoice number: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // 8. Re-fetch with relations so downstream PDF/email/event have full data.
  const { data: completeInvoice } = await supabase
    .from('invoices')
    .select('*, customer:customers(*), items:invoice_items(*)')
    .eq('id', invoice.id)
    .single()

  if (!completeInvoice) {
    throw new Error('failed to reload created invoice')
  }

  // Always emit invoice.created so existing consumers (event_log, etc.) see it.
  await eventBus.emit({
    type: 'invoice.created',
    payload: {
      invoice: completeInvoice as Invoice,
      companyId: schedule.company_id,
      userId: schedule.user_id,
    },
  })

  let autoSent = false
  let warning: string | null = null

  // 9. Auto-send path. If anything below fails, we keep the invoice (now a
  //    numbered draft) and surface a Swedish warning on the schedule — the
  //    user can manually send from /invoices/[id].
  if (schedule.auto_send) {
    try {
      const sendOutcome = await sendInvoiceFromSchedule(
        supabase,
        schedule.company_id,
        schedule.user_id,
        completeInvoice as Invoice & { customer: Customer; items: InvoiceItem[] },
      )
      autoSent = sendOutcome.sent
      if (!sendOutcome.sent) {
        warning = sendOutcome.blockedReason
          ?? 'Auto-utskick misslyckades — fakturan finns som utkast och kan skickas manuellt.'
      } else if (sendOutcome.partialFailures.length > 0) {
        // The email reached the customer, but a follow-up step failed
        // (status flip / journal entry / PDF archive). Surface it — the user
        // must be able to see and repair the gap.
        warning = `Fakturan skickades, men följande steg misslyckades: ${sendOutcome.partialFailures
          .map((f) => f.label)
          .join(', ')}. Kontrollera fakturan manuellt.`
      }
    } catch (err) {
      opLog.error('auto-send failed for recurring schedule', err as Error, {
        invoiceId: invoice.id,
      })
      warning = `Auto-utskick misslyckades: ${err instanceof Error ? err.message : 'okänt fel'}`
    }
  }

  await eventBus.emit({
    type: 'recurring_invoice.executed',
    payload: {
      scheduleId: schedule.id,
      invoice: completeInvoice as Invoice,
      autoSent,
      warning,
      companyId: schedule.company_id,
      userId: schedule.user_id,
    },
  })

  return {
    invoiceId: invoice.id,
    invoiceNumber: (completeInvoice as Invoice).invoice_number,
    autoSent,
    usedItemIds,
    period,
    warning,
  }
}

export interface ScheduleSendOutcome {
  /** True when the email actually reached the provider successfully. */
  sent: boolean
  /** Swedish reason when the send was blocked before any email left. */
  blockedReason?: string
  /**
   * Follow-up steps that failed AFTER the email was delivered
   * (status flip / journal entry / PDF archive). Mirrors the
   * partial_failures contract of the dashboard send route.
   */
  partialFailures: Array<{ step: string; label: string; reason: string }>
}

/**
 * Render PDF + send email + flip status + create JE + archive PDF.
 * Mirrors /api/invoices/[id]/send/route.ts but inline so we don't depend on
 * the route's auth chain. Partial failures after the email left are reported
 * back so the cron can persist them on the schedule/run — never silently
 * swallowed.
 */
async function sendInvoiceFromSchedule(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice & { customer: Customer; items: InvoiceItem[] },
): Promise<ScheduleSendOutcome> {
  const emailService = getEmailService()
  if (!emailService.isConfigured()) {
    log.warn('email service not configured; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
    })
    return {
      sent: false,
      blockedReason: 'E-posttjänsten är inte konfigurerad — fakturan finns som utkast och kan skickas manuellt.',
      partialFailures: [],
    }
  }
  if (!isValidEmailAddress(invoice.customer.email)) {
    log.warn('customer email missing or invalid; recurring schedule cannot auto-send', {
      invoiceId: invoice.id,
      customerId: invoice.customer.id,
    })
    return {
      sent: false,
      blockedReason: 'Kundens e-postadress saknas eller är ogiltig — fakturan finns som utkast. Uppdatera kunden och skicka manuellt.',
      partialFailures: [],
    }
  }

  // The sandbox must never deliver a real email to a real address — same
  // rule as guardSandbox on the manual send route.
  if (await isSandboxCompany(supabase, companyId)) {
    log.warn('sandbox company; recurring schedule auto-send blocked', {
      invoiceId: invoice.id,
    })
    return {
      sent: false,
      blockedReason: 'Sandlådebolag skickar aldrig riktig e-post — fakturan finns som utkast.',
      partialFailures: [],
    }
  }

  const { data: company } = await supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', companyId)
    .single<CompanySettings>()

  if (!company) {
    throw new Error('company settings missing — cannot send invoice')
  }

  const items = (invoice.items || []).slice().sort((a, b) => a.sort_order - b.sort_order)

  // Render PDF with status overridden to 'sent' so the customer doesn't
  // receive a "UTKAST" stamp. A render failure here blocks the email —
  // an invoice email without its PDF must never go out.
  const renderableInvoice = { ...invoice, status: 'sent' as const }
  const { branding } = prepareInvoicePdfRender(company)
  let pdfBuffer: Buffer
  try {
    pdfBuffer = await renderToBuffer(
      InvoicePDF({
        invoice: renderableInvoice,
        customer: invoice.customer,
        items,
        company,
        branding,
      }),
    )
  } catch (err) {
    log.error('PDF render failed in recurring schedule auto-send', err as Error, {
      invoiceId: invoice.id,
    })
    return {
      sent: false,
      blockedReason: 'PDF-genereringen misslyckades — inget e-postmeddelande skickades. Fakturan finns som utkast.',
      partialFailures: [],
    }
  }

  const filename = invoiceEmailFilename(invoice)
  const ccAddress = company.email || undefined

  const result = await emailService.sendEmail(
    buildInvoiceEmailOptions({
      invoice,
      customer: invoice.customer,
      company,
      companyId,
      pdfBuffer,
      to: invoice.customer.email!,
      ccAddress,
    }),
  )

  if (!result.success) {
    log.error(
      'email provider failed in recurring schedule auto-send',
      new Error(result.error || 'unknown'),
      { invoiceId: invoice.id },
    )
    return {
      sent: false,
      blockedReason: 'E-postleverantören kunde inte skicka fakturan — den finns som utkast och kan skickas manuellt.',
      partialFailures: [],
    }
  }

  // Email delivered — flip status, create JE, archive PDF. Treat downstream
  // failures as warnings (don't unsend the email) but report every one.
  const partialFailures: ScheduleSendOutcome['partialFailures'] = []

  const { error: statusError } = await supabase
    .from('invoices')
    .update({ status: 'sent' })
    .eq('id', invoice.id)
    .eq('company_id', companyId)
  if (statusError) {
    log.error('failed to flip recurring invoice status to sent', statusError, {
      invoiceId: invoice.id,
    })
    partialFailures.push({ step: 'status_update', label: 'statusuppdatering', reason: statusError.message })
  }

  const accountingMethod = (company as { accounting_method?: string }).accounting_method
  let journalEntryId: string | undefined
  if (!accountingMethod || accountingMethod === 'accrual') {
    try {
      const journalEntry = await createInvoiceJournalEntry(
        supabase,
        companyId,
        userId,
        invoice,
        company.entity_type,
      )
      if (journalEntry) {
        journalEntryId = journalEntry.id
        await supabase
          .from('invoices')
          .update({ journal_entry_id: journalEntry.id })
          .eq('id', invoice.id)
      }
    } catch (err) {
      log.error('failed to create journal entry for recurring invoice', err as Error, {
        invoiceId: invoice.id,
      })
      partialFailures.push({
        step: 'journal_entry',
        label: 'bokföring',
        reason: err instanceof Error ? err.message : 'okänt fel',
      })
    }
  }

  try {
    const pdfArrayBuffer = new Uint8Array(pdfBuffer).buffer as ArrayBuffer
    await uploadDocument(
      supabase,
      userId,
      companyId,
      { name: filename, buffer: pdfArrayBuffer, type: 'application/pdf' },
      { upload_source: 'system', journal_entry_id: journalEntryId },
    )
  } catch (err) {
    log.error('failed to archive recurring invoice PDF', err as Error, {
      invoiceId: invoice.id,
    })
    partialFailures.push({
      step: 'pdf_archive',
      label: 'PDF-arkivering',
      reason: err instanceof Error ? err.message : 'okänt fel',
    })
  }

  await eventBus.emit({
    type: 'invoice.sent',
    payload: { invoice, companyId, userId },
  })

  return { sent: true, partialFailures }
}
