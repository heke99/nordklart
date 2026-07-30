import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { proposeAnnualPostings } from '@/lib/bokslut/assets/depreciation-engine'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'
import {
  listStagedYearEndAdjustments,
  stageYearEndAdjustments,
} from '@/lib/core/bookkeeping/year-end-staging'

const CommitSchema = z.object({
  /** Optional whitelist — when supplied, only assets in this list are posted.
   *  Empty / omitted = post all proposed depreciations. */
  asset_ids: z.array(z.string().uuid()).optional(),
})

export const GET = withRouteContext(
  'period.depreciation_preview',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(
        createServiceClient(),
        companyId,
        user.id,
        id,
        {
          operation: 'period.depreciation_preview',
          requestId,
        },
      )
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const [proposal, stagedAdjustments, history] = await Promise.all([
        proposeAnnualPostings(supabase, companyId, id),
        listStagedYearEndAdjustments(supabase, companyId, id),
        supabase
          .from('year_end_staged_adjustments')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('fiscal_period_id', id)
          .eq('adjustment_group', 'depreciation'),
      ])
      if (history.error) throw new Error(history.error.message)
      const stagedAssetIds = stagedAdjustments
        .filter((adjustment) => adjustment.adjustment_group === 'depreciation')
        .map((adjustment) => adjustment.calculation_payload.asset_id)
        .filter((assetId): assetId is string => typeof assetId === 'string')
      return NextResponse.json({
        data: {
          ...proposal,
          stagedAssetIds,
          groupTouched: (history.count ?? 0) > 0,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)

export const POST = withRouteContext(
  'period.depreciation_commit',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CommitSchema)
    if (!validation.success) return validation.response

    try {
      const access = await requireYearEndAccess(
        createServiceClient(),
        companyId,
        user.id,
        id,
        {
          operation: 'period.depreciation_commit',
          requestId,
          requireWrite: true,
        },
      )
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const { data: period, error: periodError } = await supabase
        .from('fiscal_periods')
        .select('is_closed, locked_at, closing_entry_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()
      if (periodError || !period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      if (period.is_closed || period.closing_entry_id || period.locked_at) {
        return errorResponseFromCode('PERIOD_LOCKED', log, { requestId })
      }

      const proposal = await proposeAnnualPostings(supabase, companyId, id)
      const allowed = validation.data.asset_ids
        ? new Set(validation.data.asset_ids)
        : null
      const selected = proposal.items.filter(
        (item) =>
          !item.existingJournalEntryId &&
          (allowed === null || allowed.has(item.asset.id)),
      )
      const staged = await stageYearEndAdjustments(
        supabase,
        companyId,
        id,
        user.id,
        'depreciation',
        selected.map((item) => ({
          stable_key: `asset:${item.asset.id}`,
          adjustment_kind: 'planned_depreciation',
          description: `Planenlig avskrivning ${proposal.fiscalPeriod.name}: ${item.asset.name}`,
          entry_date: proposal.fiscalPeriod.period_end,
          journal_lines: [
            {
              account_number: item.asset.bas_expense_account,
              debit_amount: item.amount,
              credit_amount: 0,
              line_description: `Avskrivning ${item.asset.name}`,
            },
            {
              account_number: item.asset.bas_accumulated_account,
              debit_amount: 0,
              credit_amount: item.amount,
              line_description: `Ack. avskrivning ${item.asset.name}`,
            },
          ],
          calculation_payload: {
            asset_id: item.asset.id,
            schedule_id: item.existingScheduleId ?? null,
            planned_depreciation: item.amount,
          },
        })),
      )
      return NextResponse.json({ data: { staged } })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { allowRequestedCompany: true, requireWrite: true },
)
