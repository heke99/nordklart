import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * A submission state is a claim about what Skatteverket holds. It must come
 * from something Skatteverket actually returned — never from "the call did not
 * fail".
 */
const { transitionTaxSubmission } = vi.hoisted(() => ({
  transitionTaxSubmission: vi.fn().mockResolvedValue('submission-1'),
}))

vi.mock('@/lib/skatteverket/submission-pipeline', () => ({ transitionTaxSubmission }))

const { skvRequest } = vi.hoisted(() => ({ skvRequest: vi.fn() }))
vi.mock('../lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api-client')>()
  return { ...actual, skvRequest }
})

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
  createClient: vi.fn(),
}))

import { skatteverketExtension } from '../index'

function findRoute(method: string, path: string) {
  const route = skatteverketExtension.apiRoutes!.find((r) => r.method === method && r.path === path)
  if (!route) throw new Error(`route not found: ${method} ${path}`)
  return route.handler
}

function makeCtx() {
  return {
    companyId: 'company-1',
    userId: 'user-1',
    supabase: {
      from: vi.fn(() => ({
        select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { role: 'owner' }, error: null }) }) }) }) }),
        insert: () => Promise.resolve({ error: null }),
      })),
    },
    settings: { get: vi.fn(), set: vi.fn() },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  } as never
}

function request(path: string) {
  return new Request(
    `http://localhost/api/extensions/ext/skatteverket${path}?redovisare=165560000167&redovisningsperiod=202605`,
  )
}

describe.each([
  ['/declaration/submitted', 'signed_submitted'],
  ['/declaration/decided', 'receipt_received'],
])('GET %s', (path, expectedStatus) => {
  beforeEach(() => vi.clearAllMocks())

  it('does not advance the submission when Skatteverket returns an empty body', async () => {
    skvRequest.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )

    const response = await findRoute('GET', path)(request(path), makeCtx())

    expect(response.status).toBe(200)
    expect(transitionTaxSubmission).not.toHaveBeenCalled()
  })

  it('advances it when Skatteverket returns a record', async () => {
    skvRequest.mockResolvedValue(
      new Response(JSON.stringify({ kvittensnummer: 'KV-1' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    )

    await findRoute('GET', path)(request(path), makeCtx())

    expect(transitionTaxSubmission).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: expectedStatus }),
    )
  })

  it('does not advance it on a 404', async () => {
    skvRequest.mockResolvedValue(new Response('', { status: 404 }))
    await findRoute('GET', path)(request(path), makeCtx())
    expect(transitionTaxSubmission).not.toHaveBeenCalled()
  })
})
