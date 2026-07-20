import { describe, expect, it } from 'vitest'
import { generateSIEExport } from '@/lib/reports/sie-export'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { generateARLedger } from '@/lib/reports/ar-ledger'

/**
 * Pagination proofs with ≥ 2 500 rows (revision items I21, A01/A03/A07, R17).
 *
 * PostgREST caps a single response at 1 000 rows. Every aggregate that feeds
 * accounting output must therefore paginate — these tests feed 2 500+ rows
 * through the mocked page protocol (.range(from, to)) and assert that ALL
 * rows land in the result, not just the first page.
 */

const PAGE_SIZE = 1000

/** Builds a supabase mock whose table queries serve pages via .range(). */
function pagingSupabase(tables: Record<string, unknown[]>, rpcs: Record<string, unknown[]> = {}) {
  const makeBuilder = (rows: unknown[]) => {
    const state = { from: 0, to: PAGE_SIZE - 1, isRange: false }
    const builder: Record<string, unknown> = {}
    const chain = () => builder
    for (const m of [
      'select', 'eq', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'gt', 'lt', 'order', 'limit',
    ]) {
      builder[m] = chain
    }
    builder.range = (from: number, to: number) => {
      state.from = from
      state.to = to
      state.isRange = true
      return builder
    }
    builder.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null })
    builder.single = () =>
      Promise.resolve(
        rows[0]
          ? { data: rows[0], error: null }
          : { data: null, error: { message: 'not found' } },
      )
    builder.then = (
      resolve: (v: { data: unknown[]; error: null }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      void reject
      const page = state.isRange ? rows.slice(state.from, state.to + 1) : rows.slice(0, PAGE_SIZE)
      state.isRange = false
      state.from = 0
      state.to = PAGE_SIZE - 1
      return Promise.resolve(resolve({ data: page as unknown[], error: null }))
    }
    return builder
  }

  return {
    from: (table: string) => makeBuilder(tables[table] ?? []),
    rpc: (name: string) => {
      const rows = rpcs[name] ?? []
      return makeBuilder(rows)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('SIE export with 2 500 vouchers (I21)', () => {
  it('emits every #VER across multiple pages', async () => {
    const entries = Array.from({ length: 2500 }, (_, i) => ({
      id: `e-${i}`,
      voucher_series: 'A',
      voucher_number: i + 1,
      entry_date: '2025-06-01',
      description: `V${i + 1}`,
      status: 'posted',
      source_type: 'manual',
      lines: [
        { account_number: '1930', debit_amount: 10, credit_amount: 0, line_description: null },
        { account_number: '3001', debit_amount: 0, credit_amount: 10, line_description: null },
      ],
    }))

    const supabase = pagingSupabase({
      fiscal_periods: [
        {
          id: 'p1',
          period_start: '2025-01-01',
          period_end: '2025-12-31',
          opening_balance_entry_id: null,
        },
      ],
      chart_of_accounts: [
        { account_number: '1930', account_name: 'Bank', sru_code: null },
        { account_number: '3001', account_name: 'Försäljning', sru_code: null },
      ],
      journal_entries: entries,
      cost_centers: [],
      projects: [],
    })
    // Prior-period lookup: fiscal_periods maybeSingle returns the first row —
    // give it null by making the second call return nothing. Simplify: the
    // period fetch uses .single() (returns p1); the prev-period lookup uses
    // .maybeSingle() (returns p1 again — but its period_end < period_start is
    // false so prevPeriod handling still works). To keep the test focused,
    // override the fiscal_periods rows so the maybeSingle path gets null:
    let call = 0
    const origFrom = supabase.from.bind(supabase)
    supabase.from = (table: string) => {
      if (table === 'fiscal_periods') {
        call += 1
        if (call === 1) return origFrom(table)
        // prev period: none
        return {
          select: () => ({
            eq: () => ({
              lt: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: () => Promise.resolve({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          }),
        }
      }
      return origFrom(table)
    }

    // The opening-balances helper hits an RPC; stub it to empty.
    supabase.rpc = () => Promise.resolve({ data: [], error: null })

    const sie = await generateSIEExport(supabase, 'c1', {
      fiscal_period_id: 'p1',
      company_name: 'Test AB',
      org_number: '5560000000',
    })

    const verCount = (sie.match(/#VER /g) ?? []).length
    expect(verCount).toBe(2500)
    expect(sie).toContain('#VER "A" 1 ')
    expect(sie).toContain('#VER "A" 2500 ')
    // Every voucher contributes two #TRANS rows.
    const transCount = (sie.match(/#TRANS /g) ?? []).length
    expect(transCount).toBe(5000)
    // #RES for 3001 must aggregate ALL pages: 2500 × -10.
    expect(sie).toContain('#RES 0 3001 -25000.00')
  })
})

describe('bank reconciliation status with 2 500 transactions (A01/A03)', () => {
  it('counts every unmatched row across pages — never just the first 1 000', async () => {
    const transactions = Array.from({ length: 2500 }, (_, i) => ({
      id: `t-${i}`,
      amount: 10,
      journal_entry_id: null,
      reconciliation_method: null,
      is_ignored: false,
    }))

    const supabase = pagingSupabase(
      {
        transactions,
        journal_entry_lines: [],
      },
      { get_unlinked_gl_lines: [] },
    )

    const status = await getReconciliationStatus(supabase, 'c1', '2025-01-01', '2025-12-31')
    expect(status.unmatched_transaction_count).toBe(2500)
    expect(status.bank_transaction_total).toBe(25000)
    expect(status.is_reconciled).toBe(false)
  })
})

describe('historical AR ledger with 2 500 invoices (A07/A09)', () => {
  it('reconstructs every invoice across pages', async () => {
    const invoices = Array.from({ length: 2500 }, (_, i) => ({
      id: `inv-${i}`,
      invoice_number: `F${i}`,
      external_invoice_number: null,
      invoice_date: '2025-03-01',
      due_date: '2025-03-31',
      customer_id: `cust-${i % 50}`,
      status: 'sent',
      currency: 'SEK',
      exchange_rate: null,
      total: 100,
      credited_invoice_id: null,
      written_off_at: null,
    }))
    const customers = Array.from({ length: 50 }, (_, i) => ({
      id: `cust-${i}`,
      name: `Kund ${i}`,
    }))

    const supabase = pagingSupabase({
      invoices,
      invoice_payments: [],
      customers,
    })

    const report = await generateARLedger(supabase, 'c1', '2025-06-30')
    expect(report.unpaid_count).toBe(2500)
    expect(report.total_outstanding).toBe(250000)
    expect(report.entries).toHaveLength(50)
  })
})
