/**
 * Invoice-financing provider webhook: secret enforcement, replay dedupe and
 * legal status transitions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

process.env.INVOICE_FINANCING_WEBHOOK_SECRET = 'financing-test-secret'

let applicationRow: Record<string, unknown> | null = null
const writes: Array<Record<string, unknown>> = []

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({
    from: (table: string) => ({
      select() { return this },
      eq() { return this },
      maybeSingle: async () => ({ data: applicationRow, error: null }),
      insert: (row: Record<string, unknown>) => {
        writes.push({ table, kind: 'insert', ...row })
        return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) }
      },
      update(row: Record<string, unknown>) {
        writes.push({ table, kind: 'update', ...row })
        return { eq: async () => ({ data: null, error: null }) }
      },
    }),
  }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../route'
import { eventBus } from '@/lib/events/bus'

function webhookRequest(body: Record<string, unknown>, secret = 'financing-test-secret') {
  return new Request('http://localhost:3000/api/invoice-financing/provider-webhook', {
    method: 'POST',
    headers: { 'x-financing-webhook-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const application = {
  id: 'app-1',
  company_id: 'company-1',
  invoice_id: 'inv-1',
  status: 'submitted',
  recourse: false,
  created_by: 'user-1',
}

describe('POST /api/invoice-financing/provider-webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    applicationRow = null
    writes.length = 0
    eventBus.clear()
  })

  it('rejects a wrong secret', async () => {
    const response = await POST(webhookRequest({ provider_reference: 'ref-1', status: 'rejected' }, 'wrong'))
    expect(response.status).toBe(401)
  })

  it('advances a legal transition and records the event', async () => {
    applicationRow = { ...application }
    const response = await POST(webhookRequest({ provider_reference: 'ref-1', status: 'rejected', message: 'Kreditprövning avslogs' }))
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.status).toBe('rejected')
    expect(writes.some((w) => w.table === 'invoice_financing_applications' && w.kind === 'update' && w.status === 'rejected')).toBe(true)
    expect(writes.some((w) => w.table === 'invoice_financing_events' && w.kind === 'insert')).toBe(true)
  })

  it('acknowledges a same-status replay as duplicate WITHOUT side effects', async () => {
    applicationRow = { ...application, status: 'offer_created' }
    const response = await POST(webhookRequest({ provider_reference: 'ref-1', status: 'offer_created' }))
    const { status, body } = await parseJsonResponse<{ data: { duplicate: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.duplicate).toBe(true)
    expect(writes).toHaveLength(0)
  })

  it('rejects illegal transitions with 409 (terminal statuses stay terminal)', async () => {
    applicationRow = { ...application, status: 'rejected' }
    const response = await POST(webhookRequest({ provider_reference: 'ref-1', status: 'offer_created' }))
    expect(response.status).toBe(409)
    expect(writes).toHaveLength(0)
  })

  it('returns 404 for an unknown provider reference', async () => {
    const response = await POST(webhookRequest({ provider_reference: 'nope', status: 'rejected' }))
    expect(response.status).toBe(404)
  })
})
