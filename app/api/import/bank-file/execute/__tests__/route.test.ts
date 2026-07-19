import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

/**
 * Bank file execute route (revision items K01–K04, §10.4):
 *   - a file with > 500 rows where one row fails finalizes as PARTIAL, never
 *     completed,
 *   - a retry only processes the rows that are still pending/failed (no
 *     duplicates),
 *   - auto_categorize=false disables automation end-to-end,
 *   - skip_duplicates=false blocks the import when duplicates exist,
 *   - the server works from the ARCHIVED original (client transaction lists
 *     are ignored; a wrong hash is rejected).
 */

const ingestMock = vi.fn()
vi.mock('@/lib/transactions/ingest', () => ({
  ingestTransactions: (...args: unknown[]) => ingestMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: () => {} }))
vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue(undefined) },
}))

const routeCtx = {
  requireWriteCalls: 0,
}
vi.mock('@/lib/api/with-route-context', () => ({
  withRouteContext: (
    _op: string,
    handler: (req: Request, ctx: unknown) => Promise<Response>,
    options?: { requireWrite?: boolean },
  ) => {
    if (options?.requireWrite) routeCtx.requireWriteCalls++
    return (req: Request) =>
      handler(req, {
        user: { id: 'user-1' },
        supabase: supabaseMock,
        companyId: 'company-1',
        requestId: 'req-1',
        log: {
          child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
          error: vi.fn(),
          warn: vi.fn(),
          info: vi.fn(),
        },
      })
  },
}))

// 600-row generic CSV content: date,description,amount
const CSV_HEADER = 'Datum,Text,Belopp'
const CSV_ROWS = Array.from(
  { length: 600 },
  (_, i) => `2026-03-${String((i % 28) + 1).padStart(2, '0')},Rad ${i},-${(i + 1) * 10}`,
)
const FILE_CONTENT = [CSV_HEADER, ...CSV_ROWS].join('\n')

// State the mock supabase serves.
const state: {
  importRecord: Record<string, unknown> | null
  rows: Map<string, { row_key: string; status: string }>
  importUpdates: Array<Record<string, unknown>>
} = {
  importRecord: null,
  rows: new Map(),
  importUpdates: [],
}

function makeBuilder(table: string) {
  const filters: Record<string, unknown> = {}
  let updatePayload: Record<string, unknown> | null = null
  let upsertRows: Array<Record<string, unknown>> | null = null
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  builder.select = chain
  builder.eq = (col: string, val: unknown) => {
    filters[col] = val
    return builder
  }
  builder.in = chain
  builder.limit = chain
  builder.order = chain
  builder.update = (payload: Record<string, unknown>) => {
    updatePayload = payload
    return builder
  }
  builder.upsert = (rows: Array<Record<string, unknown>>) => {
    upsertRows = rows
    return builder
  }
  builder.maybeSingle = () => {
    if (table === 'bank_file_imports') {
      return Promise.resolve({ data: state.importRecord, error: null })
    }
    return Promise.resolve({ data: null, error: null })
  }
  builder.then = (resolve: (v: unknown) => unknown) => {
    if (table === 'bank_file_imports' && updatePayload) {
      state.importUpdates.push(updatePayload)
      Object.assign(state.importRecord ?? {}, updatePayload)
      return Promise.resolve(resolve({ data: null, error: null }))
    }
    if (table === 'bank_file_import_rows' && upsertRows) {
      for (const row of upsertRows) {
        const key = row.row_key as string
        if (!state.rows.has(key)) {
          state.rows.set(key, { row_key: key, status: row.status as string })
        }
      }
      return Promise.resolve(resolve({ data: null, error: null }))
    }
    if (table === 'bank_file_import_rows' && updatePayload) {
      const key = filters.row_key as string
      const row = state.rows.get(key)
      if (row) row.status = (updatePayload as { status: string }).status
      return Promise.resolve(resolve({ data: null, error: null }))
    }
    if (table === 'bank_file_import_rows') {
      return Promise.resolve(
        resolve({ data: [...state.rows.values()], error: null }),
      )
    }
    if (table === 'transactions') {
      return Promise.resolve(resolve({ data: [], error: null }))
    }
    return Promise.resolve(resolve({ data: null, error: null }))
  }
  return builder
}

const supabaseMock = {
  from: (table: string) => makeBuilder(table),
  storage: {
    from: () => ({
      download: () =>
        Promise.resolve({ data: { text: () => Promise.resolve(FILE_CONTENT) }, error: null }),
    }),
  },
}

async function loadRoute() {
  const mod = await import('../route')
  return mod.POST as unknown as (req: Request) => Promise<Response>
}

// The real hash of FILE_CONTENT (route recomputes and compares).
async function realHash(): Promise<string> {
  const { generateFileHash } = await import('@/lib/import/bank-file/parser')
  return generateFileHash(FILE_CONTENT)
}

const COLUMN_MAPPING = {
  date: 0,
  description: 1,
  amount: 2,
  delimiter: ',',
  decimal_separator: '.' as const,
  skip_rows: 1,
  date_format: 'YYYY-MM-DD',
}

beforeEach(() => {
  ingestMock.mockReset()
  state.rows = new Map()
  state.importUpdates = []
})

describe('POST /api/import/bank-file/execute', () => {
  it('row 501 failing in a 600-row file finalizes as PARTIAL, and a retry only processes the failed row (K04)', async () => {
    const hash = await realHash()
    state.importRecord = {
      id: 'import-1',
      filename: 'bank.csv',
      file_format: 'generic_csv',
      file_storage_path: `company-1/${hash}.dat`,
      file_hash: hash,
      status: 'pending',
      imported_rows: 0,
      duplicate_rows: 0,
      failed_rows: 0,
    }

    // First run: every row imports except one (simulating row 501 failing).
    ingestMock.mockImplementationOnce(
      async (_s: unknown, _c: unknown, _u: unknown, raw: Array<{ external_id: string }>) => {
        const rowResults = raw.map((r, i) => ({
          external_id: r.external_id,
          status: i === 500 ? ('error' as const) : ('imported' as const),
          transaction_id: i === 500 ? null : `tx-${i}`,
          error: i === 500 ? 'insert failed' : null,
        }))
        return {
          imported: raw.length - 1,
          duplicates: 0,
          reconciled: 0,
          auto_categorized: 0,
          auto_matched_invoices: 0,
          errors: 1,
          transaction_ids: rowResults.filter((r) => r.transaction_id).map((r) => r.transaction_id),
          automation_errors: 0,
          mapping_required: 0,
          row_results: rowResults,
          first_error: { message: 'insert failed' },
        }
      },
    )

    const POST = await loadRoute()
    const res = await POST(
      createMockRequest('http://test/api/import/bank-file/execute', {
        method: 'POST',
        body: {
          file_hash: hash,
          skip_duplicates: true,
          auto_categorize: true,
          settlement_account: '1930',
          column_mapping: COLUMN_MAPPING,
        },
      }),
    )
    const { status, body } = await parseJsonResponse<{ data: { status: string; imported: number } }>(res)
    expect(status).toBe(200)
    expect(body.data.status).toBe('partial')
    expect(body.data.imported).toBe(599)

    // The persisted final status is partial — never completed.
    const finalUpdate = state.importUpdates[state.importUpdates.length - 1]
    expect(finalUpdate.status).toBe('partial')
    expect(finalUpdate.failed_rows).toBe(1)

    // ── Retry: only the failed row is re-processed ──
    ingestMock.mockImplementationOnce(
      async (_s: unknown, _c: unknown, _u: unknown, raw: Array<{ external_id: string }>) => {
        expect(raw).toHaveLength(1) // ONLY the failed row — no duplicates
        return {
          imported: 1,
          duplicates: 0,
          reconciled: 0,
          auto_categorized: 0,
          auto_matched_invoices: 0,
          errors: 0,
          transaction_ids: ['tx-retry'],
          automation_errors: 0,
          mapping_required: 0,
          row_results: raw.map((r) => ({
            external_id: r.external_id,
            status: 'imported' as const,
            transaction_id: 'tx-retry',
            error: null,
          })),
        }
      },
    )

    const retryRes = await POST(
      createMockRequest('http://test/api/import/bank-file/execute', {
        method: 'POST',
        body: {
          file_hash: hash,
          skip_duplicates: true,
          auto_categorize: true,
          settlement_account: '1930',
          column_mapping: COLUMN_MAPPING,
        },
      }),
    )
    const { body: retryBody } = await parseJsonResponse<{ data: { status: string } }>(retryRes)
    expect(retryBody.data.status).toBe('completed')
  })

  it('auto_categorize=false disables automation end-to-end (K01)', async () => {
    const hash = await realHash()
    state.importRecord = {
      id: 'import-2',
      filename: 'bank.csv',
      file_format: 'generic_csv',
      file_storage_path: `company-1/${hash}.dat`,
      file_hash: hash,
      status: 'pending',
    }
    ingestMock.mockResolvedValueOnce({
      imported: 600,
      duplicates: 0,
      reconciled: 0,
      auto_categorized: 0,
      auto_matched_invoices: 0,
      errors: 0,
      transaction_ids: [],
      automation_errors: 0,
      mapping_required: 0,
      row_results: [],
    })

    const POST = await loadRoute()
    await POST(
      createMockRequest('http://test/api/import/bank-file/execute', {
        method: 'POST',
        body: {
          file_hash: hash,
          skip_duplicates: true,
          auto_categorize: false,
          settlement_account: '1930',
          column_mapping: COLUMN_MAPPING,
        },
      }),
    )

    const ingestOptions = ingestMock.mock.calls[0][4] as { disableAutomation?: boolean }
    expect(ingestOptions.disableAutomation).toBe(true)
  })

  it('skip_duplicates=false blocks the import when duplicates are found (K02)', async () => {
    const hash = await realHash()
    state.importRecord = {
      id: 'import-3',
      filename: 'bank.csv',
      file_format: 'generic_csv',
      file_storage_path: `company-1/${hash}.dat`,
      file_hash: hash,
      status: 'pending',
    }
    ingestMock.mockImplementationOnce(
      async (_s: unknown, _c: unknown, _u: unknown, raw: Array<{ external_id: string }>) => ({
        imported: raw.length - 2,
        duplicates: 2,
        reconciled: 0,
        auto_categorized: 0,
        auto_matched_invoices: 0,
        errors: 0,
        transaction_ids: [],
        automation_errors: 0,
        mapping_required: 0,
        row_results: raw.map((r, i) => ({
          external_id: r.external_id,
          status: i < 2 ? ('duplicate' as const) : ('imported' as const),
          transaction_id: i < 2 ? null : `tx-${i}`,
          error: null,
        })),
      }),
    )

    const POST = await loadRoute()
    const res = await POST(
      createMockRequest('http://test/api/import/bank-file/execute', {
        method: 'POST',
        body: {
          file_hash: hash,
          skip_duplicates: false,
          auto_categorize: true,
          settlement_account: '1930',
          column_mapping: COLUMN_MAPPING,
        },
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    const finalUpdate = state.importUpdates[state.importUpdates.length - 1]
    expect(finalUpdate.status).toBe('failed')
  })

  it('rejects a client-supplied hash that does not match the archived original (K03)', async () => {
    const hash = await realHash()
    const wrongHash = 'a'.repeat(64)
    state.importRecord = {
      id: 'import-4',
      filename: 'bank.csv',
      file_format: 'generic_csv',
      file_storage_path: `company-1/${wrongHash}.dat`,
      file_hash: wrongHash,
      status: 'pending',
    }
    void hash

    const POST = await loadRoute()
    const res = await POST(
      createMockRequest('http://test/api/import/bank-file/execute', {
        method: 'POST',
        body: {
          file_hash: wrongHash,
          skip_duplicates: true,
          auto_categorize: true,
          settlement_account: '1930',
          column_mapping: COLUMN_MAPPING,
        },
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(ingestMock).not.toHaveBeenCalled()
  })
})
