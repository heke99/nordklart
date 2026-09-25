import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import {
  INVENTORY_CHANGE_ACCOUNTS,
  InventoryValuationError,
  planInventoryAdjustment,
  valueInventory,
} from '@/lib/bokslut/inventory/inventory-valuation'
import type { CreateJournalEntryLineInput } from '@/types'

ensureInitialized()

/**
 * Lagerinventering for fiscal year `[id]`. GET: booked balance of each
 * inventory account at the balance date. POST: book the lagerförändring that
 * brings each counted account to its value (IL 17 kap. 3–4 §§), as one
 * voucher dated the balance date. Re-posting the same count is a no-op: the
 * adjustment is always counted from the current booked balance.
 */

const CountSchema = z.object({
  account: z.enum(Object.keys(INVENTORY_CHANGE_ACCOUNTS) as [string, ...string[]]),
  cost: z.number().nonnegative(),
  net_realizable_value: z.number().nonnegative().nullable().optional(),
  method: z.enum(['lowest_value', 'alternative_97']).default('lowest_value'),
})

const BodySchema = z.object({
  counts: z.array(CountSchema).min(1).max(Object.keys(INVENTORY_CHANGE_ACCOUNTS).length),
})

async function bookedBalances(companyId: string, periodEnd: string): Promise<Record<string, number>> {
  const db = createServiceClient()
  const entries = await Promise.all(
    Object.keys(INVENTORY_CHANGE_ACCOUNTS).map(async (account) => {
      const { data, error } = await db.rpc('__ledger_balance_at', {
        p_company_id: companyId,
        p_account_from: account,
        p_account_to: account,
        p_date: periodEnd,
      })
      if (error) throw error
      // The helper is credit-positive; inventory is debit-normal.
      return [account, -(Number(data) || 0)] as const
    }),
  )
  return Object.fromEntries(entries)
}

async function loadPeriod(supabase: ReturnType<typeof createServiceClient>, companyId: string, id: string) {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, period_end, is_closed, locked_at')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  return data as { id: string; period_end: string; is_closed: boolean; locked_at: string | null } | null
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'period.year_end_inventory_read',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const access = await requireYearEndAccess(createServiceClient(), ctx.companyId, ctx.user.id, id, {
      operation: 'period.year_end_inventory_read',
      requestId: ctx.requestId,
    })
    if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
    const period = await loadPeriod(ctx.supabase, ctx.companyId, id)
    if (!period) return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    const balances = await bookedBalances(ctx.companyId, period.period_end)
    return NextResponse.json({
      data: {
        balance_date: period.period_end,
        accounts: Object.entries(INVENTORY_CHANGE_ACCOUNTS).map(([account, meta]) => ({
          account,
          label: meta.label,
          change_account: meta.changeAccount,
          booked_balance: balances[account] ?? 0,
        })),
      },
    })
  },
  { allowRequestedCompany: true },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'period.year_end_inventory',
  async (request, ctx, { params }) => {
    const { id } = await params
    const access = await requireYearEndAccess(createServiceClient(), ctx.companyId, ctx.user.id, id, {
      operation: 'period.year_end_inventory',
      requestId: ctx.requestId,
      requireWrite: true,
    })
    if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
    const validation = await validateBody(request, BodySchema)
    if (!validation.success) return validation.response

    const period = await loadPeriod(ctx.supabase, ctx.companyId, id)
    if (!period) return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    if (period.is_closed || period.locked_at) {
      return errorResponseFromCode('PERIOD_LOCKED', ctx.log, { requestId: ctx.requestId })
    }

    const accounts = validation.data.counts.map((c) => c.account)
    if (new Set(accounts).size !== accounts.length) {
      return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        messageSv: 'Varje lagerkonto får bara förekomma en gång.',
        messageEn: 'Each inventory account may appear only once.',
      })
    }

    let valuations
    try {
      valuations = validation.data.counts.map((c) =>
        valueInventory({ account: c.account, cost: c.cost, netRealizableValue: c.net_realizable_value ?? null, method: c.method }),
      )
    } catch (error) {
      if (error instanceof InventoryValuationError) {
        return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, messageSv: error.message })
      }
      throw error
    }

    const balances = await bookedBalances(ctx.companyId, period.period_end)
    const lines: CreateJournalEntryLineInput[] = valuations.flatMap((v) => planInventoryAdjustment(v, balances[v.account] ?? 0))
    if (lines.length === 0) {
      return NextResponse.json({ data: { journal_entry: null, valuations } })
    }

    const entry = await createJournalEntry(ctx.supabase, ctx.companyId, ctx.user.id, {
      fiscal_period_id: id,
      entry_date: period.period_end,
      description: 'Lagerförändring enligt inventering',
      source_type: 'year_end_inventory',
      lines,
    })
    return NextResponse.json({ data: { journal_entry: entry, valuations } }, { status: 201 })
  },
  { allowRequestedCompany: true, requireWrite: true },
)
