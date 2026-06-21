import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { K3ComponentSchema } from '@/lib/api/schemas'
import { getAsset, updateAsset } from '@/lib/bokslut/assets/asset-service'
import { validateComponents } from '@/lib/bokslut/assets/k3-components'
import { componentValidationBase, validateAssetPropertyRules } from '@/lib/bokslut/assets/property-rules'
import type { AccountingDepreciationModel, AssetSubtype, DepreciationMethod, PropertyKind } from '@/types'


const ASSET_SUBTYPES: readonly AssetSubtype[] = [
  'standard',
  'building',
  'land',
  'land_improvement',
  'property_component',
  'low_value_inventory',
  'short_life_inventory',
] as const

const PROPERTY_KINDS: readonly PropertyKind[] = [
  'hyreshus',
  'industribyggnad',
  'ekonomibyggnad',
  'ovrig',
  'mixed',
] as const

const ACCOUNTING_DEPRECIATION_MODELS: readonly AccountingDepreciationModel[] = [
  'k2_single_unit',
  'k3_components',
  'tax_plan',
] as const

const DEPRECIATION_METHODS: readonly DepreciationMethod[] = [
  'linear',
  'declining_balance_30',
  'declining_balance_20',
  'restvardesavskrivning_25',
] as const

const UpdateAssetSchema = z
  .object({
    name: z.string().min(1).optional(),
    notes: z.string().nullable().optional(),
    asset_subtype: z.enum(ASSET_SUBTYPES as unknown as [AssetSubtype, ...AssetSubtype[]]).nullable().optional(),
    property_kind: z.enum(PROPERTY_KINDS as unknown as [PropertyKind, ...PropertyKind[]]).nullable().optional(),
    land_value: z.number().nonnegative().nullable().optional(),
    building_value: z.number().nonnegative().nullable().optional(),
    tax_depreciation_rate: z.number().min(0).max(100).nullable().optional(),
    accounting_depreciation_rate: z.number().min(0).max(100).nullable().optional(),
    accounting_depreciation_model: z.enum(ACCOUNTING_DEPRECIATION_MODELS as unknown as [AccountingDepreciationModel, ...AccountingDepreciationModel[]]).nullable().optional(),
    acquisition_source_document_id: z.string().uuid().nullable().optional(),
    supplier_invoice_id: z.string().uuid().nullable().optional(),
    bank_transaction_id: z.string().uuid().nullable().optional(),
    private_use_percentage: z.number().min(0).max(100).optional(),
    business_use_percentage: z.number().min(0).max(100).optional(),
    salvage_value: z.number().nonnegative().optional(),
    useful_life_months: z.number().int().positive().optional(),
    depreciation_method: z
      .enum(DEPRECIATION_METHODS as unknown as [DepreciationMethod, ...DepreciationMethod[]])
      .optional(),
    restvarde_target: z.number().nonnegative().nullable().optional(),
    bas_asset_account: z.string().regex(/^\d{4}$/).optional(),
    bas_accumulated_account: z.string().regex(/^\d{4}$/).optional(),
    bas_expense_account: z.string().regex(/^\d{4}$/).optional(),
    // K3 component depreciation. Accepting `null` lets the caller clear an
    // existing breakdown (the engine then falls back to depreciation_method).
    // Per-component validation runs whenever the field is set to a non-null
    // value; the cross-sum check needs acquisition_cost so it's deferred to
    // updateAsset() which can read the existing row.
    k3_components: z.array(K3ComponentSchema).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    // Enforce the method/target biconditional when EITHER field is supplied.
    // We can't see the existing row from a zod refinement, so the
    // application-level updateAsset() carries the cross-row check; here we
    // only catch the obviously inconsistent combinations within a single
    // PATCH body.
    const hasMethod = value.depreciation_method !== undefined
    const hasTarget = value.restvarde_target !== undefined
    if (!hasMethod && !hasTarget) return

    const isRestvarde = value.depreciation_method === 'restvardesavskrivning_25'
    const targetIsSet = value.restvarde_target !== null && value.restvarde_target !== undefined

    if (hasMethod && isRestvarde && hasTarget && !targetIsSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restvarde_target'],
        message: 'restvarde_target krävs när avskrivningsmetoden är restvärdeavskrivning (25 %).',
      })
    }
    if (hasMethod && !isRestvarde && hasTarget && targetIsSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['restvarde_target'],
        message: 'restvarde_target får bara anges för restvärdeavskrivning (25 %).',
      })
    }
  })

export const GET = withRouteContext(
  'assets.get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      const asset = await getAsset(supabase, companyId, id)
      if (!asset) {
        return NextResponse.json({ error: { code: 'ASSET_NOT_FOUND' } }, { status: 404 })
      }
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
)

export const PATCH = withRouteContext(
  'assets.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, UpdateAssetSchema)
    if (!validation.success) return validation.response

    // K3 component depreciation gating + cross-sum check.
    // The Zod refinement cannot see the existing asset's acquisition_cost,
    // so we do both the framework check and the sum validation here at
    // route level before delegating to updateAsset().
    if (validation.data.k3_components !== undefined && validation.data.k3_components !== null) {
      const [{ data: company }, existing] = await Promise.all([
        supabase
          .from('companies')
          .select('accounting_framework')
          .eq('id', companyId)
          .single(),
        getAsset(supabase, companyId, id),
      ])
      if (!company || company.accounting_framework !== 'k3') {
        return NextResponse.json(
          {
            error: {
              code: 'K3_REQUIRED_FOR_COMPONENTS',
              message: 'Komponentuppdelning (k3_components) kräver att företaget tillämpar K3 (BFNAR 2012:1).',
            },
          },
          { status: 422 },
        )
      }
      if (!existing) {
        return NextResponse.json({ error: { code: 'ASSET_NOT_FOUND' } }, { status: 404 })
      }
      const mergedForComponents = { ...existing, ...validation.data, acquisition_cost: Number(existing.acquisition_cost) }
      const { errors } = validateComponents({
        acquisition_cost: componentValidationBase(mergedForComponents),
        k3_components: validation.data.k3_components,
      })
      if (errors.length > 0) {
        return NextResponse.json(
          {
            error: {
              code: 'INVALID_K3_COMPONENTS',
              message: errors.join(' '),
            },
          },
          { status: 400 },
        )
      }
    }

    if (
      validation.data.asset_subtype !== undefined ||
      validation.data.property_kind !== undefined ||
      validation.data.land_value !== undefined ||
      validation.data.building_value !== undefined ||
      validation.data.private_use_percentage !== undefined ||
      validation.data.business_use_percentage !== undefined ||
      validation.data.useful_life_months !== undefined ||
      validation.data.k3_components !== undefined
    ) {
      const [{ data: company }, existing] = await Promise.all([
        supabase.from('companies').select('accounting_framework').eq('id', companyId).single(),
        getAsset(supabase, companyId, id),
      ])
      if (!existing) {
        return NextResponse.json({ error: { code: 'ASSET_NOT_FOUND' } }, { status: 404 })
      }
      const merged = { ...existing, ...validation.data, acquisition_cost: Number(existing.acquisition_cost) }
      const propertyValidation = validateAssetPropertyRules(
        merged,
        company?.accounting_framework === 'k3' ? 'k3' : 'k2',
      )
      if (propertyValidation.errors.length > 0) {
        return NextResponse.json(
          { error: { code: 'INVALID_ASSET_PROPERTY_RULES', message: propertyValidation.errors.join(' ') } },
          { status: 422 },
        )
      }
    }

    try {
      const asset = await updateAsset(supabase, companyId, id, validation.data)
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
