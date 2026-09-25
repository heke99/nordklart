import type { SupabaseClient } from '@supabase/supabase-js'
import { createDraftEntry } from '@/lib/bookkeeping/engine'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import type { CreateJournalEntryLineInput, JournalEntry } from '@/types'
import {
  INVENTORY_CHANGE_ACCOUNTS,
  planInventoryAdjustment,
  type InventoryValuation,
} from './inventory-valuation'

const log = createLogger('inventory-adjustment')

export type InventoryErrorCode =
  | 'INVENTORY_BALANCE_CHANGED'
  | 'INVENTORY_PERIOD_CLOSED'
  | 'INVENTORY_PERIOD_NOT_FOUND'
  | 'INVENTORY_DRAFT_INVALID'

export class InventoryAdjustmentError extends Error {
  constructor(
    public readonly code: InventoryErrorCode,
    public readonly details?: string,
  ) {
    super(code)
    this.name = 'InventoryAdjustmentError'
  }
}

const KNOWN_CODES: InventoryErrorCode[] = [
  'INVENTORY_BALANCE_CHANGED',
  'INVENTORY_PERIOD_CLOSED',
  'INVENTORY_PERIOD_NOT_FOUND',
  'INVENTORY_DRAFT_INVALID',
]

/**
 * Booked balance (debit-positive) of every inventory account at the balance
 * date. `service` must be a service-role client (__ledger_balance_at).
 */
export async function loadInventoryBalances(
  service: SupabaseClient,
  companyId: string,
  balanceDate: string,
): Promise<Record<string, number>> {
  const entries = await Promise.all(
    Object.keys(INVENTORY_CHANGE_ACCOUNTS).map(async (account) => {
      const { data, error } = await service.rpc('__ledger_balance_at', {
        p_company_id: companyId,
        p_account_from: account,
        p_account_to: account,
        p_date: balanceDate,
      })
      if (error) throw new Error(error.message)
      // The helper is credit-positive; inventory is debit-normal.
      return [account, -(Number(data) || 0)] as const
    }),
  )
  return Object.fromEntries(entries)
}

/**
 * Book the lagerförändring that brings each counted account to its value.
 * The voucher is drafted through the engine and committed by
 * commit_inventory_adjustment, which re-checks the balances it was computed
 * from under a lock — two concurrent counts can never both post.
 * Returns null when every account already carries its counted value.
 */
export async function bookInventoryAdjustment(
  params: {
    supabase: SupabaseClient
    service: SupabaseClient
    companyId: string
    userId: string
    fiscalPeriodId: string
    balanceDate: string
  },
  valuations: InventoryValuation[],
): Promise<JournalEntry | null> {
  const { supabase, service, companyId, userId, fiscalPeriodId, balanceDate } = params
  const balances = await loadInventoryBalances(service, companyId, balanceDate)
  const expected: Record<string, number> = {}
  const lines: CreateJournalEntryLineInput[] = []
  for (const v of valuations) {
    const booked = balances[v.account] ?? 0
    expected[v.account] = booked
    lines.push(...planInventoryAdjustment(v, booked))
  }
  if (lines.length === 0) return null

  const draft = await createDraftEntry(supabase, companyId, userId, {
    fiscal_period_id: fiscalPeriodId,
    entry_date: balanceDate,
    description: 'Lagerförändring enligt inventering',
    source_type: 'year_end_inventory',
    lines,
  })

  const { error } = await service.rpc('commit_inventory_adjustment', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_draft_entry_id: draft.id,
    p_expected: expected,
  })
  if (error) {
    const { error: cancelError } = await supabase
      .from('journal_entries')
      .update({ status: 'cancelled' })
      .eq('id', draft.id)
      .eq('company_id', companyId)
      .eq('status', 'draft')
    if (cancelError) log.error('inventory draft cleanup failed (draft remains)', cancelError, { draftId: draft.id })
    const code = KNOWN_CODES.find((c) => c === error.message)
    if (code) throw new InventoryAdjustmentError(code, error.details)
    throw new Error(error.message)
  }

  const { data: entry, error: loadError } = await supabase
    .from('journal_entries')
    .select('*, lines:journal_entry_lines(*)')
    .eq('id', draft.id)
    .eq('company_id', companyId)
    .single()
  if (loadError || !entry) throw new Error(loadError?.message ?? 'Verifikationen kunde inte läsas.')
  await eventBus.emit({ type: 'journal_entry.committed', payload: { entry: entry as JournalEntry, userId, companyId } })
  return entry as JournalEntry
}
