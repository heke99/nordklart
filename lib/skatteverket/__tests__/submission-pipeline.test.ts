import { describe, it, expect, vi, beforeEach } from 'vitest'
import { transitionTaxSubmission, TAX_SUBMISSION_STATUS_SV } from '../submission-pipeline'
import type { SupabaseClient } from '@supabase/supabase-js'

type TableCall = { table: string; op: 'insert' | 'update'; values: Record<string, unknown> }

function makePipelineClient(existing: { id: string; status: string } | null) {
  const calls: TableCall[] = []
  const client = {
    from: vi.fn().mockImplementation((table: string) => {
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      builder.select = vi.fn().mockImplementation(chain)
      builder.eq = vi.fn().mockImplementation(chain)
      builder.order = vi.fn().mockImplementation(chain)
      builder.limit = vi.fn().mockImplementation(chain)
      builder.maybeSingle = vi.fn().mockResolvedValue({ data: existing, error: null })
      builder.single = vi.fn().mockResolvedValue({ data: { id: 'new-submission-1' }, error: null })
      builder.insert = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        calls.push({ table, op: 'insert', values })
        // insert().select().single() chain for tax_submissions; plain await for events
        const insertChain: Record<string, unknown> = {
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'new-submission-1' }, error: null }),
          }),
          then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
        }
        return insertChain
      })
      builder.update = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        calls.push({ table, op: 'update', values })
        return builder
      })
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      return builder
    }),
  } as unknown as SupabaseClient
  return { client, calls }
}

describe('transitionTaxSubmission', () => {
  beforeEach(() => vi.clearAllMocks())

  it('creates a submission row + event when none exists', async () => {
    const { client, calls } = makePipelineClient(null)
    const id = await transitionTaxSubmission(client, {
      companyId: 'c1',
      userId: 'u1',
      submissionType: 'vat_return',
      periodKey: '202606',
      status: 'prepared',
      eventType: 'moms.validated',
      amount: 14380,
    })

    expect(id).toBe('new-submission-1')
    const submissionInsert = calls.find((c) => c.table === 'tax_submissions' && c.op === 'insert')
    expect(submissionInsert?.values).toMatchObject({
      company_id: 'c1',
      submission_type: 'vat_return',
      period_key: '202606',
      status: 'prepared',
      amount: 14380,
      prepared_by: 'u1',
    })
    const eventInsert = calls.find((c) => c.table === 'tax_submission_events')
    expect(eventInsert?.values).toMatchObject({
      event_type: 'moms.validated',
      status_from: null,
      status_to: 'prepared',
      created_by: 'u1',
    })
  })

  it('updates the existing row and records the from→to transition', async () => {
    const { client, calls } = makePipelineClient({ id: 'sub-1', status: 'sent_to_skatteverket' })
    const id = await transitionTaxSubmission(client, {
      companyId: 'c1',
      userId: 'u1',
      submissionType: 'vat_return',
      periodKey: '202606',
      status: 'waiting_for_signature',
      eventType: 'moms.draft_locked',
    })

    expect(id).toBe('sub-1')
    const update = calls.find((c) => c.table === 'tax_submissions' && c.op === 'update')
    expect(update?.values).toMatchObject({ status: 'waiting_for_signature', sent_by: 'u1' })
    const eventInsert = calls.find((c) => c.table === 'tax_submission_events')
    expect(eventInsert?.values).toMatchObject({
      status_from: 'sent_to_skatteverket',
      status_to: 'waiting_for_signature',
    })
  })

  it('stamps receipt fields on receipt_received', async () => {
    const { client, calls } = makePipelineClient({ id: 'sub-1', status: 'signed_submitted' })
    await transitionTaxSubmission(client, {
      companyId: 'c1',
      userId: 'u1',
      submissionType: 'agi',
      periodKey: '202606',
      status: 'receipt_received',
      eventType: 'agi.kvittens_received',
      receiptReference: 'uuid-kvittens-1',
    })
    const update = calls.find((c) => c.table === 'tax_submissions' && c.op === 'update')
    expect(update?.values).toMatchObject({
      status: 'receipt_received',
      receipt_reference: 'uuid-kvittens-1',
    })
    expect(update?.values.receipt_received_at).toBeTruthy()
  })

  it('never throws — returns null when the client is unusable', async () => {
    const id = await transitionTaxSubmission(null as never, {
      companyId: 'c1',
      userId: 'u1',
      submissionType: 'vat_return',
      periodKey: '202606',
      status: 'draft',
      eventType: 'x',
    })
    expect(id).toBeNull()
  })

  it('has Swedish labels for every status', () => {
    for (const status of ['draft', 'prepared', 'sent_to_skatteverket', 'waiting_for_signature', 'signed_submitted', 'receipt_received', 'failed', 'cancelled'] as const) {
      expect(TAX_SUBMISSION_STATUS_SV[status]).toBeTruthy()
    }
  })
})
