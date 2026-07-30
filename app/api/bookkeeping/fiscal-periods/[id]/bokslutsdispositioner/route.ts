import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { calculateBolagsskatt } from '@/lib/bokslut/tax-provision/bolagsskatt-calculator'
import { calculateSarskildLoneskatt } from '@/lib/bokslut/tax-provision/sarskild-loneskatt-calculator'
import {
  listExistingPeriodiseringsfonder,
  proposeAvsattning,
  proposeAteforing,
} from '@/lib/bokslut/reserves/periodiseringsfond-service'
import { proposeOveravskrivningar } from '@/lib/bokslut/reserves/overavskrivningar-service'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import {
  buildDispositionsProposal,
  buildLatentTaxProposal,
} from '@/lib/bokslut/dispositions-proposal-builder'
import type { ProposedDisposition } from '@/lib/bokslut/types'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import {
  getYearEndRuleset,
  stageYearEndAdjustments,
  type StageYearEndAdjustmentInput,
  type YearEndRuleset,
} from '@/lib/core/bookkeeping/year-end-staging'

/**
 * Canonical bokslut order. Each calculator re-reads the trial balance to
 * derive its base, so earlier items must post before later items see their
 * effect: återföring → överavskrivningar → avsättning → SLP → bolagsskatt.
 * The POST handler enforces this order regardless of how the client sends
 * its items array, so the avsättning 25 % cap can never be evaluated
 * against a stale (pre-återföring) net result.
 */
const DISPOSITION_ORDER: Record<string, number> = {
  periodiseringsfond_ateforing: 0,
  overavskrivningar: 1,
  periodiseringsfond_avsattning: 2,
  sarskild_loneskatt: 3,
  bolagsskatt: 4,
  // K3 only — posts last because it depends on the closing 21xx balance,
  // which only stabilises once avsättning / återföring have been applied.
  uppskjuten_skatt: 5,
}

// ============================================================
// GET — return proposal snapshot with defaults
// ============================================================
export const GET = withRouteContext(
  'period.bokslutsdispositioner_preview',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.bokslutsdispositioner_preview',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const data = await buildDispositionsProposal(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('bokslutsdispositioner preview failed', err as Error)
      return errorResponse(err, opLog, { requestId })
    }
  },
  { allowRequestedCompany: true },
)

// ============================================================
// POST — commit a list of dispositions chosen by the user
// ============================================================
const ItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bolagsskatt'),
    manualAdjustments: z
      .object({
        nonDeductibleExpenses: z.number().optional(),
        nonTaxableIncome: z.number().optional(),
        schablonintaktPeriodiseringsfond: z.number().optional(),
        other: z.number().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('sarskild_loneskatt'),
    manualAdjustment: z.number().optional(),
  }),
  z.object({
    kind: z.literal('periodiseringsfond_avsattning'),
    desiredAmount: z.number().optional(),
  }),
  z.object({
    kind: z.literal('periodiseringsfond_ateforing'),
    returns: z.record(z.string(), z.number()).default({}),
  }),
  z.object({
    kind: z.literal('overavskrivningar'),
    additionalAmount: z.number(),
    /** Asset category for BAS account selection — defaults to maskiner &
     *  inventarier (8853/2153), the dominant K2 case. */
    category: z
      .enum(['machinery_equipment', 'building', 'immaterial', 'group'])
      .optional(),
  }),
  // K3 only — uppskjuten skatt provision. Server recomputes the amount from
  // current 2240 + 21xx state so the client cannot override it.
  z.object({
    kind: z.literal('uppskjuten_skatt'),
  }),
])

const PostBodySchema = z.object({
  items: z.array(ItemSchema).min(1),
}).superRefine(({ items }, ctx) => {
  const kinds = new Set<string>()
  for (const [index, item] of items.entries()) {
    if (kinds.has(item.kind)) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', index, 'kind'],
        message: `Dispositionstypen ${item.kind} får bara förekomma en gång i batchen.`,
      })
    }
    kinds.add(item.kind)
  }
})

export const POST = withRouteContext(
  'period.bokslutsdispositioner_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    const validation = await validateBody(request, PostBodySchema)
    if (!validation.success) return validation.response

    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.bokslutsdispositioner_post',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const { data: period, error: periodError } = await supabase
        .from('fiscal_periods')
        .select('id, name, period_end, is_closed, locked_at, closing_entry_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .single()
      if (periodError || !period) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', opLog, { requestId })
      }
      if (period.is_closed || period.closing_entry_id || period.locked_at) {
        return errorResponseFromCode('PERIOD_LOCKED', opLog, { requestId })
      }

      const fiscalYear = parseInt(period.period_end.slice(0, 4), 10)
      const ruleset = await getYearEndRuleset(supabase, fiscalYear)

      // Process items in canonical bokslut order regardless of client array
      // ordering — each computation pulls the current income statement, so
      // återföring must post before avsättning sees its cap base; över-
      // avskrivningar must post before bolagsskatt; SLP and bolagsskatt last.
      const sortedItems = [...validation.data.items].sort(
        (a, b) => DISPOSITION_ORDER[a.kind] - DISPOSITION_ORDER[b.kind],
      )

      const stagedItems: StageYearEndAdjustmentInput[] = []
      for (const item of sortedItems) {
        const proposal = await computeProposal(
          item,
          supabase,
          companyId,
          id,
          fiscalYear,
          ruleset,
        )
        if (!proposal) continue

        stagedItems.push({
          stable_key: proposal.kind,
          adjustment_kind: proposal.kind,
          description: `Bokslutsdisposition: ${proposal.label}`,
          entry_date: period.period_end,
          journal_lines: proposal.lines,
          calculation_payload: { request: item, proposal, tax_year: fiscalYear },
          ruleset_version: ruleset.version,
        })
      }

      const staged = await stageYearEndAdjustments(
        supabase,
        companyId,
        id,
        user.id,
        'disposition',
        stagedItems,
      )
      return NextResponse.json({ data: { staged, ruleset } })
    } catch (err) {
      opLog.error('bokslutsdispositioner post failed', err as Error)
      return errorResponse(err, opLog, { requestId })
    }
  },
  { allowRequestedCompany: true },
)

type PostItem = z.infer<typeof ItemSchema>

async function computeProposal(
  item: PostItem,
  supabase: Parameters<typeof calculateBolagsskatt>[0],
  companyId: string,
  fiscalPeriodId: string,
  fiscalYear: number,
  ruleset: YearEndRuleset,
): Promise<ProposedDisposition | null> {
  switch (item.kind) {
    case 'bolagsskatt':
      return calculateBolagsskatt(supabase, companyId, fiscalPeriodId, {
        manualAdjustments: item.manualAdjustments,
      })
    case 'sarskild_loneskatt':
      return calculateSarskildLoneskatt(supabase, companyId, fiscalPeriodId, {
        manualAdjustment: item.manualAdjustment,
      })
    case 'periodiseringsfond_avsattning': {
      // Re-derive the cap base from current state so the user can't sneak in
      // a higher desiredAmount than 25 % of actual skattemässigt resultat.
      const incomeStatement = await generateIncomeStatement(
        supabase,
        companyId,
        fiscalPeriodId,
      )
      const { data: periodRow } = await supabase
        .from('fiscal_periods')
        .select('period_end')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()
      const periodEnd = periodRow?.period_end ?? `${fiscalYear}-12-31`
      const existing = await listExistingPeriodiseringsfonder(supabase, companyId, periodEnd)
      const schablonintaktRate = ruleset.schablonintakt_rate
      const schablonintakt = existing.reduce(
        (sum, f) => sum + f.balance * schablonintaktRate,
        0,
      )
      const base = incomeStatement.net_result + Math.round(schablonintakt)
      return proposeAvsattning({
        skattemassigtResultatBeforeAvsattning: base,
        desiredAmount: item.desiredAmount,
        fiscalYear,
      })
    }
    case 'periodiseringsfond_ateforing': {
      // Recompute existing fonder server-side so the user can't return more
      // than is on the books.
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('period_end')
        .eq('id', fiscalPeriodId)
        .eq('company_id', companyId)
        .single()
      if (!period) return null
      const existing = await listExistingPeriodiseringsfonder(
        supabase,
        companyId,
        period.period_end,
      )
      const result = proposeAteforing(existing, {
        returns: item.returns,
        schablonintaktRate: ruleset.schablonintakt_rate,
      })
      // Combine multiple cohort reversals into a single voucher with multiple
      // lines so we don't blow up voucher numbering — but each fond is its own
      // line pair already. Build a merged ProposedDisposition.
      if (result.proposals.length === 0) return null
      return mergeAteforingProposals(result.proposals)
    }
    case 'overavskrivningar':
      return proposeOveravskrivningar({
        additionalAmount: item.additionalAmount,
        category: item.category,
      })
    case 'uppskjuten_skatt':
      // Server-only: recompute from current TB (which already reflects any
      // 21xx postings that committed earlier in this batch). The client
      // sends no amount — the calculator owns the K3 split.
      return buildLatentTaxProposal({
        supabase,
        companyId,
        fiscalPeriodId,
      })
  }
}

function mergeAteforingProposals(proposals: ProposedDisposition[]): ProposedDisposition {
  const lines = proposals.flatMap((p) => p.lines)
  const totalAmount = proposals.reduce((sum, p) => sum + p.amount, 0)
  const warnings = proposals.flatMap((p) => p.warnings)
  return {
    kind: 'periodiseringsfond_ateforing',
    label: 'Återföring periodiseringsfond',
    description: proposals.map((p) => p.label).join(', '),
    amount: totalAmount,
    lines,
    warnings,
  }
}
