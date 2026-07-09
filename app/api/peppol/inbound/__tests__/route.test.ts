/**
 * Peppol inbound webhook: secret enforcement + replay dedupe. A redelivered
 * UBL must be acknowledged without creating a second delivery row or WORM
 * document.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

process.env.PEPPOL_INBOUND_SECRET = 'peppol-test-secret'

type QueryResult = { data?: unknown; error?: unknown }
let queue: QueryResult[] = []
const inserts: Array<Record<string, unknown>> = []

function chain(table: string): Record<string, unknown> {
  const result = queue.shift() ?? { data: null, error: null }
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
        return (...args: unknown[]) => {
          if (prop === 'insert') inserts.push({ table, ...(args[0] as Record<string, unknown>) })
          return proxy
        }
      },
    },
  ) as Record<string, unknown>
  return proxy
}

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({ from: (table: string) => chain(table) }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const uploadDocumentMock = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => uploadDocumentMock(...args),
}))

import { POST } from '../route'
import { eventBus } from '@/lib/events/bus'

const UBL = `<?xml version="1.0"?><Invoice><cbc:ID>F-100</cbc:ID></Invoice>${'x'.repeat(50)}`
const COMPANY_ID = '44444444-4444-4444-8444-444444444444'

function webhookRequest(body: Record<string, unknown>, secret = 'peppol-test-secret') {
  return new Request('http://localhost:3000/api/peppol/inbound', {
    method: 'POST',
    headers: { 'x-peppol-inbound-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/peppol/inbound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queue = []
    inserts.length = 0
    eventBus.clear()
    uploadDocumentMock.mockResolvedValue({ id: 'doc-1' })
  })

  it('rejects a wrong secret', async () => {
    const response = await POST(webhookRequest({ company_id: COMPANY_ID, ubl_xml: UBL }, 'wrong'))
    expect(response.status).toBe(401)
  })

  it('registers a fresh delivery, archives the UBL and returns the delivery id', async () => {
    queue = [
      { data: { id: COMPANY_ID, created_by: 'user-1' }, error: null }, // company lookup
      { data: { id: 'delivery-1' }, error: null }, // delivery insert
      { data: null, error: null }, // metadata update after archive
    ]

    const response = await POST(webhookRequest({ company_id: COMPANY_ID, ubl_xml: UBL }))
    const { status, body } = await parseJsonResponse<{ data: { delivery_id: string; document_id: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.delivery_id).toBe('delivery-1')
    expect(uploadDocumentMock).toHaveBeenCalledTimes(1)
    // The insert claims the (company, content) slot with a hash.
    expect(inserts[0]).toMatchObject({ table: 'e_invoice_deliveries', direction: 'inbound' })
    expect(typeof inserts[0].content_sha256).toBe('string')
  })

  it('acknowledges a replay WITHOUT archiving a second document', async () => {
    queue = [
      { data: { id: COMPANY_ID, created_by: 'user-1' }, error: null }, // company lookup
      { data: null, error: { code: '23505', message: 'duplicate' } }, // insert conflict
      { data: { id: 'delivery-1' }, error: null }, // existing delivery lookup
    ]

    const response = await POST(webhookRequest({ company_id: COMPANY_ID, ubl_xml: UBL }))
    const { status, body } = await parseJsonResponse<{ data: { delivery_id: string; duplicate: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.duplicate).toBe(true)
    expect(body.data.delivery_id).toBe('delivery-1')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('rejects unknown tenants', async () => {
    queue = [{ data: null, error: null }]
    const response = await POST(webhookRequest({ company_id: COMPANY_ID, ubl_xml: UBL }))
    expect(response.status).toBe(404)
  })
})
