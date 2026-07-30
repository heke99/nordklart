import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import {
  buildAccrualsProposal,
  proposeAccruedInterest,
  proposeAccruedUtility,
  proposeAuditFee,
  proposeManualAccrued,
  proposeManualPrepaid,
  proposeRevenueDeferral,
  proposeVacationLiabilityChange,
} from '@/lib/bokslut/accruals/accrual-detector'
import { detectPeriodisering } from '@/lib/bokslut/accruals/auto-detect'
import type { AccrualProposal } from '@/lib/bokslut/accruals/types'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'
import {
  listStagedYearEndAdjustments,
  stageYearEndAdjustments,
  type StageYearEndAdjustmentInput,
} from '@/lib/core/bookkeeping/year-end-staging'

export const GET = withRouteContext(
  'period.accruals_preview',
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
          operation: 'period.accruals_preview',
          requestId,
        },
      )
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      // Run the two independent scans in parallel so the wizard's first
      // paint isn't gated on the slower auto-detect query.
      const [proposal, autoDetected, stagedAdjustments, history] = await Promise.all([
        buildAccrualsProposal(supabase, companyId, id),
        detectPeriodisering(supabase, companyId, id).catch((err) => {
          // Auto-detect is best-effort — a malformed invoice description
          // shouldn't break the rest of the preflight. Log + return empty.
          log.warn('auto-detect failed', { error: (err as Error)?.message })
          return []
        }),
        listStagedYearEndAdjustments(supabase, companyId, id),
        supabase
          .from('year_end_staged_adjustments')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('fiscal_period_id', id)
          .eq('adjustment_group', 'accrual'),
      ])
      if (history.error) throw new Error(history.error.message)
      return NextResponse.json({
        data: {
          ...proposal,
          autoDetected,
          groupTouched: (history.count ?? 0) > 0,
          stagedAdjustments: stagedAdjustments.filter(
            (adjustment) => adjustment.adjustment_group === 'accrual',
          ),
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

// Defense-in-depth on caller-supplied account numbers. The wizard sends
// accounts from a closed template list, but the API accepts them as plain
// strings so we constrain the BAS class per accrual kind:
//   - cost accounts (5xxx-8xxx) for expense legs
//   - revenue accounts (3xxx) for revenue legs
//   - 17xx for förutbetalda kostnader (prepaid)
//   - 29xx for upplupna poster (accrued / deferred)
// Anything outside these ranges is rejected with 400 before reaching the
// engine — keeps a compromised browser session from posting arbitrary
// balance-sheet hits.
const EXPENSE_ACCOUNT_RE = /^[5-8]\d{3}$/
const REVENUE_ACCOUNT_RE = /^3\d{3}$/

const PostItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('vacation_liability_change') }),
  z.object({
    kind: z.literal('audit_fee'),
    amount: z.number().positive(),
    liability_account: z.enum(['2991', '2992']).optional(),
  }),
  z.object({
    kind: z.literal('manual_prepaid_expense'),
    amount: z.number().positive(),
    expense_account: z.string().regex(EXPENSE_ACCOUNT_RE),
    prepaid_account: z.string().regex(/^17\d{2}$/),
    description: z.string().min(1),
  }),
  z.object({
    kind: z.literal('manual_accrued_expense'),
    amount: z.number().positive(),
    expense_account: z.string().regex(EXPENSE_ACCOUNT_RE),
    accrued_account: z.string().regex(/^29\d{2}$/),
    description: z.string().min(1),
  }),
  z.object({
    kind: z.literal('deferred_revenue'),
    amount: z.number().positive(),
    revenue_account: z.string().regex(REVENUE_ACCOUNT_RE),
    deferred_account: z.string().regex(/^29\d{2}$/),
    description: z.string().min(1),
  }),
  z.object({
    kind: z.literal('accrued_interest'),
    amount: z.number().positive(),
    expense_account: z.string().regex(EXPENSE_ACCOUNT_RE),
    accrued_account: z.string().regex(/^29\d{2}$/),
    description: z.string().min(1),
  }),
  z.object({
    kind: z.literal('accrued_utility'),
    amount: z.number().positive(),
    expense_account: z.string().regex(EXPENSE_ACCOUNT_RE),
    accrued_account: z.string().regex(/^29\d{2}$/),
    description: z.string().min(1),
  }),
])

const PostBodySchema = z.object({
  items: z.array(PostItemSchema),
})

export const POST = withRouteContext(
  'period.accruals_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, PostBodySchema)
    if (!validation.success) return validation.response

    try {
      const access = await requireYearEndAccess(
        createServiceClient(),
        companyId,
        user.id,
        id,
        {
          operation: 'period.accruals_post',
          requestId,
          requireWrite: true,
        },
      )
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const { data: period, error: periodError } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_end, is_closed, locked_at, closing_entry_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()
      if (periodError || !period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      if (period.is_closed || period.closing_entry_id || period.locked_at) {
        return errorResponseFromCode('PERIOD_LOCKED', log, { requestId })
      }

      const stagedItems: StageYearEndAdjustmentInput[] = []

      for (const item of validation.data.items) {
        let proposal: AccrualProposal | null = null
        switch (item.kind) {
          case 'vacation_liability_change':
            proposal = await proposeVacationLiabilityChange(supabase, companyId, id, {
              closingDate: period.period_end,
            })
            break
          case 'audit_fee':
            proposal = proposeAuditFee({
              amount: item.amount,
              closingDate: period.period_end,
              liabilityAccount: item.liability_account,
            })
            break
          case 'manual_prepaid_expense':
            proposal = proposeManualPrepaid({
              amount: item.amount,
              expenseAccount: item.expense_account,
              prepaidAccount: item.prepaid_account,
              description: item.description,
              closingDate: period.period_end,
            })
            break
          case 'manual_accrued_expense':
            proposal = proposeManualAccrued({
              amount: item.amount,
              expenseAccount: item.expense_account,
              accruedAccount: item.accrued_account,
              description: item.description,
              closingDate: period.period_end,
            })
            break
          case 'deferred_revenue':
            proposal = proposeRevenueDeferral({
              amount: item.amount,
              revenueAccount: item.revenue_account,
              deferredAccount: item.deferred_account,
              description: item.description,
              closingDate: period.period_end,
            })
            break
          case 'accrued_interest':
            proposal = proposeAccruedInterest({
              amount: item.amount,
              expenseAccount: item.expense_account,
              accruedAccount: item.accrued_account,
              description: item.description,
              closingDate: period.period_end,
            })
            break
          case 'accrued_utility':
            proposal = proposeAccruedUtility({
              amount: item.amount,
              expenseAccount: item.expense_account,
              accruedAccount: item.accrued_account,
              description: item.description,
              closingDate: period.period_end,
            })
            break
        }
        if (!proposal) continue

        const description = proposal.reverses_on
          ? `Periodisering: ${proposal.label} (vänds ${proposal.reverses_on})`
          : `Bokslutsjustering: ${proposal.label}`
        const stableKeyParts = [
          item.kind,
          'description' in item ? item.description : '',
          'expense_account' in item ? item.expense_account : '',
          'liability_account' in item ? item.liability_account ?? '' : '',
        ]
        stagedItems.push({
          stable_key: stableKeyParts.join(':'),
          adjustment_kind: item.kind,
          description,
          entry_date: period.period_end,
          reversal_date: proposal.reverses_on,
          journal_lines: proposal.lines,
          calculation_payload: { request: item, proposal },
        })
      }

      const staged = await stageYearEndAdjustments(
        supabase,
        companyId,
        id,
        user.id,
        'accrual',
        stagedItems,
      )
      return NextResponse.json({ data: { staged } })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { allowRequestedCompany: true, requireWrite: true },
)
