import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import {
  loadAutomationSettings,
  DEFAULT_AUTOMATION_SETTINGS,
} from '@/lib/automation/bank-transaction-automation'

// /api/automation/settings — read/write surface for company_automation_settings
// (Batch 11). Powers /settings/automation.
//
// Security model:
//   - GET: any company member may read (RLS read policy).
//   - PUT: RLS write policy requires company admin/owner — the upsert runs on
//     the user-scoped client, so a member/viewer gets a Postgres RLS error
//     which we map to 403. requireWrite adds the app-side write check on top.
//   - Every change is auditable: the table has an audit trigger, and we log
//     the operation with request id.

const AUTOMATION_MODES = ['off', 'suggest', 'auto_safe', 'auto_full'] as const
const AFTER_SYNC_MODES = ['off', 'suggest_only', 'process_pending', 'auto_safe'] as const

const settingsSchema = z.object({
  bank_transaction_mode: z.enum(AUTOMATION_MODES),
  invoice_payment_matching_mode: z.enum(AUTOMATION_MODES),
  supplier_invoice_matching_mode: z.enum(AUTOMATION_MODES),
  bank_import_after_sync_mode: z.enum(AFTER_SYNC_MODES),
  min_auto_confidence: z.number().min(0.5).max(1),
  min_suggestion_confidence: z.number().min(0).max(1),
  max_auto_book_amount: z.number().positive().nullable(),
  allow_auto_customer_invoice_settlement: z.boolean(),
  allow_auto_supplier_invoice_settlement: z.boolean(),
  allow_auto_bank_fee_booking: z.boolean(),
  allow_auto_category_booking: z.boolean(),
  allow_auto_tax_payment_booking: z.boolean(),
  allow_auto_salary_payment_booking: z.boolean(),
})

export const GET = withRouteContext('automation.settings.read', async (_request, ctx) => {
  const { supabase, companyId } = ctx
  const settings = await loadAutomationSettings(supabase, companyId!)

  // camelCase engine shape → snake_case API shape (mirrors the table columns
  // so the settings form round-trips without a mapping layer client-side).
  return NextResponse.json({
    data: {
      bank_transaction_mode: settings.bankTransactionMode,
      invoice_payment_matching_mode: settings.invoicePaymentMatchingMode,
      supplier_invoice_matching_mode: settings.supplierInvoiceMatchingMode,
      bank_import_after_sync_mode: settings.bankImportAfterSyncMode,
      min_auto_confidence: settings.minAutoConfidence,
      min_suggestion_confidence: settings.minSuggestionConfidence,
      max_auto_book_amount: settings.maxAutoBookAmount,
      allow_auto_customer_invoice_settlement: settings.allowAutoCustomerInvoiceSettlement,
      allow_auto_supplier_invoice_settlement: settings.allowAutoSupplierInvoiceSettlement,
      allow_auto_bank_fee_booking: settings.allowAutoBankFeeBooking,
      allow_auto_category_booking: settings.allowAutoCategoryBooking,
      allow_auto_tax_payment_booking: settings.allowAutoTaxPaymentBooking,
      allow_auto_salary_payment_booking: settings.allowAutoSalaryPaymentBooking,
      defaults: {
        min_auto_confidence: DEFAULT_AUTOMATION_SETTINGS.minAutoConfidence,
        min_suggestion_confidence: DEFAULT_AUTOMATION_SETTINGS.minSuggestionConfidence,
      },
    },
  })
})

export const PUT = withRouteContext(
  'automation.settings.update',
  async (request, ctx) => {
    const { supabase, companyId, user, log } = ctx

    const validation = await validateBody(request, settingsSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Guard rail: suggestion threshold must not exceed the auto threshold —
    // otherwise nothing between them can ever be suggested.
    if (body.min_suggestion_confidence > body.min_auto_confidence) {
      return NextResponse.json(
        {
          error:
            'Tröskeln för förslag kan inte vara högre än tröskeln för automatisk bokföring.',
        },
        { status: 400 },
      )
    }

    const { error } = await supabase
      .from('company_automation_settings')
      .upsert(
        {
          company_id: companyId,
          ...body,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'company_id' },
      )

    if (error) {
      // RLS denial (member/viewer) surfaces as a permission error.
      const isRls = /row-level security|permission denied/i.test(error.message)
      log.warn('automation settings update failed', {
        userId: user.id,
        rls: isRls,
        error: error.message,
      })
      return NextResponse.json(
        {
          error: isRls
            ? 'Endast ägare och administratörer kan ändra automationsinställningarna.'
            : 'Inställningarna kunde inte sparas.',
        },
        { status: isRls ? 403 : 500 },
      )
    }

    log.info('automation settings updated', {
      userId: user.id,
      mode: body.bank_transaction_mode,
      afterSync: body.bank_import_after_sync_mode,
    })

    return NextResponse.json({ data: { success: true } })
  },
  { requireWrite: true },
)
