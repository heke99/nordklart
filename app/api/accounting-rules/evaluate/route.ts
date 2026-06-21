import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createDefaultEntityContext, evaluatePurchaseForAccounting, normalizeEntityType, normalizeIndustryCode } from '@/lib/accounting-rules'

const EvaluateAccountingRuleSchema = z.object({
  source_type: z.enum(['bank_transaction', 'supplier_invoice', 'receipt', 'customer_invoice', 'manual', 'asset']).default('manual'),
  source_id: z.string().uuid().nullable().optional(),
  description: z.string().min(1),
  amount_ex_vat: z.number().nonnegative(),
  vat_amount: z.number().nonnegative().nullable().optional(),
  vat_rate: z.number().min(0).max(25).nullable().optional(),
  supplier_name: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  expected_useful_life_months: z.number().int().positive().nullable().optional(),
  business_use_percent: z.number().min(0).max(100).nullable().optional(),
  private_use_percent: z.number().min(0).max(100).nullable().optional(),
  natural_bundle_total_ex_vat: z.number().nonnegative().nullable().optional(),
  is_company_purchase: z.boolean().nullable().optional(),
  is_representation: z.boolean().nullable().optional(),
  is_vehicle: z.boolean().nullable().optional(),
  is_property_related: z.boolean().nullable().optional(),
  is_financial_or_insurance: z.boolean().nullable().optional(),
  is_eu_or_import: z.boolean().nullable().optional(),
  persist: z.boolean().default(false),
})

export const POST = withRouteContext(
  'accounting_rules.evaluate',
  async (request, ctx) => {
    const { supabase, companyId, user } = ctx
    const validation = await validateBody(request, EvaluateAccountingRuleSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const [{ data: settings }, { data: company }] = await Promise.all([
      supabase.from('company_settings').select('entity_type, vat_registered').eq('company_id', companyId).maybeSingle(),
      supabase.from('companies').select('accounting_framework').eq('id', companyId).maybeSingle(),
    ])

    const decision = evaluatePurchaseForAccounting(
      {
        description: body.description,
        amountExVat: body.amount_ex_vat,
        vatAmount: body.vat_amount,
        vatRate: body.vat_rate,
        supplierName: body.supplier_name,
        category: body.category,
        purchaseDate: body.purchase_date,
        expectedUsefulLifeMonths: body.expected_useful_life_months,
        businessUsePercent: body.business_use_percent,
        privateUsePercent: body.private_use_percent,
        naturalBundleTotalExVat: body.natural_bundle_total_ex_vat,
        isCompanyPurchase: body.is_company_purchase,
        isRepresentation: body.is_representation,
        isVehicle: body.is_vehicle,
        isPropertyRelated: body.is_property_related,
        isFinancialOrInsurance: body.is_financial_or_insurance,
        isEuOrImport: body.is_eu_or_import,
      },
      createDefaultEntityContext({
        entityType: normalizeEntityType(settings?.entity_type),
        industryCode: normalizeIndustryCode(null),
        accountingFramework: company?.accounting_framework === 'k3' ? 'k3' : 'k2',
        isVatRegistered: settings?.vat_registered ?? true,
      }),
    )

    let storedDecisionId: string | null = null
    if (body.persist) {
      const { data, error } = await supabase
        .from('accounting_rule_decisions')
        .insert({
          company_id: companyId,
          user_id: user.id,
          source_type: body.source_type,
          source_id: body.source_id ?? null,
          decision: decision.decision,
          account_number: decision.accountNumber,
          vat_treatment: decision.vatTreatment,
          deductible_percentage: decision.deductiblePercentage,
          private_percentage: decision.privatePercentage,
          reason_code: decision.reasonCode,
          explanation_sv: decision.explanationSv,
          review_severity: decision.reviewSeverity,
          required_evidence: decision.requiredEvidence,
          warnings: decision.warnings,
          suggested_asset: decision.suggestedAsset ?? null,
        })
        .select('id')
        .single()
      if (error) throw new Error(`Kunde inte spara regelbeslut: ${error.message}`)
      storedDecisionId = data.id

      if (decision.reviewSeverity === 'warning' || decision.reviewSeverity === 'danger' || decision.reviewSeverity === 'blocking') {
        await supabase.from('accounting_review_queue').insert({
          company_id: companyId,
          rule_decision_id: storedDecisionId,
          source_type: body.source_type,
          source_id: body.source_id ?? null,
          severity: decision.reviewSeverity,
          title: 'Granska bokföringsförslag',
          description: decision.explanationSv,
        })
      }
    }

    return NextResponse.json({ data: { decision, stored_decision_id: storedDecisionId } })
  },
  { requireWrite: true },
)
