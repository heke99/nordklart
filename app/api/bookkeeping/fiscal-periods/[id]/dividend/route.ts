import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'
import {
  assessDividendPrudence,
  bookDividendDecision,
  bookDividendPayment,
  DividendError,
  ku31Obligation,
} from '@/lib/core/bookkeeping/dividend-service'

ensureInitialized()

/**
 * Utdelning for the fiscal year `[id]` (the balance-sheet year the dividend is
 * paid from). GET: the board's proposal, the stämma's decision, payments, the
 * ABL 17:3 limit and the key figures for the försiktighetsregel. POST:
 * `decide` books the stämma's decision, `pay` books a payout.
 *
 * The RPCs are service_role only; access is checked first with
 * requireYearEndAccess (write for POST).
 */

const isoDate = z.string().date()

const DecideSchema = z.object({
  action: z.literal('decide'),
  decision_date: isoDate,
  amount: z.number().positive(),
  payment_date: isoDate.optional(),
  deviation_reason: z.string().trim().max(2000).optional(),
})

const PaySchema = z.object({
  action: z.literal('pay'),
  payment_date: isoDate,
  amount: z.number().positive(),
  cash_account: z.string().regex(/^19\d{2}$/).optional(),
})

const CommandSchema = z.discriminatedUnion('action', [DecideSchema, PaySchema])

async function loadState(db: ReturnType<typeof createServiceClient>, companyId: string, periodId: string) {
  const [disposition, proposal] = await Promise.all([
    db
      .from('year_end_profit_dispositions')
      .select('id, current_year_result, free_equity, proposed_dividend, carried_forward, status, locked_at')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', periodId)
      .maybeSingle(),
    db
      .from('dividend_proposals')
      .select('id, total_amount, amount_per_share, share_count, planned_payment_date, status, board_reasoning, prudence_assessment')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', periodId)
      .neq('status', 'withdrawn')
      .maybeSingle(),
  ])
  if (disposition.error) throw disposition.error
  if (proposal.error) throw proposal.error

  let decision: Record<string, unknown> | null = null
  let payments: Array<Record<string, unknown>> = []
  if (proposal.data) {
    const { data, error } = await db
      .from('dividend_decisions')
      .select('id, decision_date, decided_amount, payment_date, deviation_reason, journal_entry_id')
      .eq('company_id', companyId)
      .eq('dividend_proposal_id', proposal.data.id)
      .maybeSingle()
    if (error) throw error
    decision = data
    if (decision) {
      const { data: rows, error: payError } = await db
        .from('dividend_payments')
        .select('id, amount, paid_on, journal_entry_id')
        .eq('company_id', companyId)
        .eq('dividend_decision_id', decision.id as string)
        .order('paid_on')
      if (payError) throw payError
      payments = rows ?? []
    }
  }
  return { disposition: disposition.data, proposal: proposal.data, decision, payments }
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'period.year_end_dividend_read',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { user, companyId } = ctx
    const db = createServiceClient()
    const access = await requireYearEndAccess(db, companyId, user.id, id, {
      operation: 'period.year_end_dividend_read',
      requestId: ctx.requestId,
    })
    if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

    const { data: period, error: periodError } = await db
      .from('fiscal_periods')
      .select('id, period_end')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()
    if (periodError || !period) return errorResponseFromCode('DIVIDEND_PROPOSAL_NOT_FOUND', ctx.log, { requestId: ctx.requestId })

    const state = await loadState(db, companyId, id)

    let limits: unknown = null
    let prudence: unknown = null
    if (state.proposal) {
      const asOf = (state.decision?.decision_date as string | undefined) ?? new Date().toISOString().slice(0, 10)
      const { data, error } = await db.rpc('dividend_distributable_amount', {
        p_company_id: companyId,
        p_dividend_proposal_id: state.proposal.id,
        p_as_of: asOf < period.period_end ? period.period_end : asOf,
      })
      if (error) throw error
      limits = data

      const balance = async (from: string, to: string) => {
        const { data: value, error: balanceError } = await db.rpc('__ledger_balance_at', {
          p_company_id: companyId,
          p_account_from: from,
          p_account_to: to,
          p_date: period.period_end,
        })
        if (balanceError) throw balanceError
        return Number(value) || 0
      }
      const [equity, untaxed, assets, cash] = await Promise.all([
        balance('2000', '2099'),
        balance('2100', '2199'),
        balance('1000', '1999'),
        balance('1900', '1999'),
      ])
      // Assets are debit-normal: the helper is credit-positive.
      prudence = assessDividendPrudence({
        equity,
        untaxedReserves: untaxed,
        totalAssets: -assets,
        cash: -cash,
        dividend: Number(state.proposal.total_amount) || 0,
      })
    }

    const ku31 = state.decision
      ? ku31Obligation(state.decision.decision_date as string, (state.decision.payment_date as string | null) ?? null)
      : null

    return NextResponse.json({ data: { ...state, limits, prudence, ku31 } })
  },
  { allowRequestedCompany: true },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'period.year_end_dividend_write',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { user, companyId } = ctx
    const db = createServiceClient()
    const access = await requireYearEndAccess(db, companyId, user.id, id, {
      operation: 'period.year_end_dividend_write',
      requestId: ctx.requestId,
      requireWrite: true,
    })
    if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

    const validation = await validateBody(request, CommandSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    try {
      const state = await loadState(db, companyId, id)
      if (body.action === 'decide') {
        if (!state.proposal) return errorResponseFromCode('DIVIDEND_PROPOSAL_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
        const result = await bookDividendDecision(db, {
          companyId,
          userId: user.id,
          dividendProposalId: state.proposal.id,
          decisionDate: body.decision_date,
          amount: body.amount,
          paymentDate: body.payment_date ?? null,
          deviationReason: body.deviation_reason ?? null,
        })
        return NextResponse.json(
          {
            data: {
              dividend_decision_id: result.dividendDecisionId,
              journal_entry: result.entry,
              payment_date: result.paymentDate,
              limits: result.limits,
              ku31: result.ku31,
            },
          },
          { status: 201 },
        )
      }

      if (!state.decision) return errorResponseFromCode('DIVIDEND_DECISION_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
      const result = await bookDividendPayment(db, {
        companyId,
        userId: user.id,
        dividendDecisionId: state.decision.id as string,
        paymentDate: body.payment_date,
        amount: body.amount,
        cashAccount: body.cash_account,
      })
      return NextResponse.json({ data: { journal_entry: result.entry, remaining: result.remaining } }, { status: 201 })
    } catch (error) {
      if (error instanceof DividendError) {
        return errorResponseFromCode(error.code, ctx.log, { requestId: ctx.requestId, reason: error.details })
      }
      throw error
    }
  },
  { allowRequestedCompany: true, requireWrite: true },
)
