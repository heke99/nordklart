import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bookkeeping/engine', () => ({ createDraftEntry: vi.fn() }))

import { createDraftEntry } from '@/lib/bookkeeping/engine'
import { eventBus } from '@/lib/events'
import { bookInventoryAdjustment, InventoryAdjustmentError } from '../book-inventory-adjustment'
import { valueInventory } from '../inventory-valuation'

function clients(booked1460: number, commitError: { message: string } | null = null) {
  const updates: unknown[] = []
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) builder[m] = () => builder
  builder.update = (arg: unknown) => { updates.push(arg); return builder }
  builder.single = async () => ({ data: { id: 'draft-1', status: 'posted' }, error: null })
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
  const supabase = { from: vi.fn(() => builder) }
  const service = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === '__ledger_balance_at') return { data: args.p_account_from === '1460' ? -booked1460 : 0, error: null }
      return { data: commitError ? null : { journal_entry_id: 'draft-1' }, error: commitError }
    }),
  }
  return { supabase, service, updates }
}

const ctx = (c: ReturnType<typeof clients>) => ({
  supabase: c.supabase as never, service: c.service as never,
  companyId: 'c1', userId: 'u1', fiscalPeriodId: 'p1', balanceDate: '2026-12-31',
})

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  vi.mocked(createDraftEntry).mockResolvedValue({ id: 'draft-1' } as never)
})

describe('bookInventoryAdjustment', () => {
  it('drafts the difference and commits it with the balances it was computed from', async () => {
    const c = clients(100_000)
    const entry = await bookInventoryAdjustment(ctx(c), [valueInventory({ account: '1460', cost: 120_000, method: 'lowest_value' })])
    expect(entry).toMatchObject({ id: 'draft-1' })
    expect(vi.mocked(createDraftEntry).mock.calls[0][3]).toMatchObject({ source_type: 'year_end_inventory', entry_date: '2026-12-31' })
    expect(c.service.rpc).toHaveBeenCalledWith('commit_inventory_adjustment', expect.objectContaining({ p_expected: { '1460': 100_000 } }))
  })

  it('books nothing when the balance already matches', async () => {
    const c = clients(120_000)
    expect(await bookInventoryAdjustment(ctx(c), [valueInventory({ account: '1460', cost: 120_000, method: 'lowest_value' })])).toBeNull()
    expect(createDraftEntry).not.toHaveBeenCalled()
  })

  it('cancels the draft when a concurrent count won', async () => {
    const c = clients(100_000, { message: 'INVENTORY_BALANCE_CHANGED' })
    await expect(bookInventoryAdjustment(ctx(c), [valueInventory({ account: '1460', cost: 120_000, method: 'lowest_value' })]))
      .rejects.toBeInstanceOf(InventoryAdjustmentError)
    expect(c.updates).toContainEqual({ status: 'cancelled' })
  })
})
