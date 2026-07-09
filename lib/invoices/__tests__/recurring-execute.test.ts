/**
 * executeRecurringSchedule behavior tests: draft-only vs auto-send, customer
 * email validation, sandbox blocking, PDF failure blocking, provider failure
 * and partial-failure surfacing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const sendEmailMock = vi.fn()
const isConfiguredMock = vi.fn().mockReturnValue(true)
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({
    isConfigured: () => isConfiguredMock(),
    sendEmail: (...args: unknown[]) => sendEmailMock(...args),
  }),
}))

const renderToBufferMock = vi.fn()
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: (...args: unknown[]) => renderToBufferMock(...args),
}))

vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: vi.fn(() => ({})),
}))

vi.mock('@/lib/invoices/pdf-render-helpers', () => ({
  prepareInvoicePdfRender: vi.fn(() => ({ branding: {} })),
}))

const ensureInvoiceNumberMock = vi.fn()
vi.mock('@/lib/invoices/ensure-invoice-number', () => ({
  ensureInvoiceNumber: (...args: unknown[]) => ensureInvoiceNumberMock(...args),
}))

const createJournalEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: (...args: unknown[]) => createJournalEntryMock(...args),
}))

const uploadDocumentMock = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => uploadDocumentMock(...args),
}))

vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn().mockResolvedValue(null),
  convertToSEK: vi.fn(),
}))

const isSandboxMock = vi.fn().mockResolvedValue(false)
vi.mock('@/lib/sandbox/guard', () => ({
  isSandboxCompany: (...args: unknown[]) => isSandboxMock(...args),
}))

import { executeRecurringSchedule } from '@/lib/invoices/recurring-schedule-service'
import type { RecurringInvoiceSchedule, RecurringInvoiceScheduleItem } from '@/types'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const customer = {
  id: 'cust-1',
  name: 'Kund AB',
  email: 'kund@test.se',
  customer_type: 'company',
  vat_number_validated: false,
}

const insertedInvoice = { id: 'inv-1', invoice_number: null, status: 'draft' }
const completeInvoice = {
  id: 'inv-1',
  invoice_number: 'F-100',
  status: 'draft',
  document_type: 'invoice',
  customer,
  items: [{ id: 'ii-1', sort_order: 0, description: 'X', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 25 }],
}

function makeSchedule(overrides: Partial<RecurringInvoiceSchedule> = {}): RecurringInvoiceSchedule & { items: RecurringInvoiceScheduleItem[] } {
  return {
    id: 'sched-1',
    company_id: 'company-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    name: 'Retainer',
    day_of_month: 15,
    payment_terms_days: 30,
    currency: 'SEK',
    your_reference: null,
    our_reference: null,
    notes: null,
    auto_send: false,
    status: 'active',
    next_run_date: '2026-08-15',
    last_run_at: null,
    last_invoice_id: null,
    last_run_warning: null,
    generated_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    items: [
      {
        id: 'item-1',
        schedule_id: 'sched-1',
        sort_order: 0,
        description: 'Konsultarvode',
        quantity: 1,
        unit: 'st',
        unit_price: 100,
        vat_rate: 25,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    ...overrides,
  }
}

/** Enqueue the base spawn pipeline: customer, invoice insert, items, refetch. */
function enqueueSpawnPipeline(customerRow: Record<string, unknown> = customer, complete: Record<string, unknown> = completeInvoice) {
  enqueue({ data: customerRow, error: null }) // customers select
  enqueue({ data: insertedInvoice, error: null }) // invoices insert
  enqueue({ data: null, error: null }) // invoice_items insert
  enqueue({ data: complete, error: null }) // refetch with relations
}

describe('executeRecurringSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    isConfiguredMock.mockReturnValue(true)
    isSandboxMock.mockResolvedValue(false)
    renderToBufferMock.mockResolvedValue(Buffer.from('pdf'))
    sendEmailMock.mockResolvedValue({ success: true, messageId: 'msg-1' })
    ensureInvoiceNumberMock.mockResolvedValue(undefined)
    createJournalEntryMock.mockResolvedValue({ id: 'je-1' })
    uploadDocumentMock.mockResolvedValue({ id: 'doc-1' })
  })

  it('auto_send=false creates a draft only, no email', async () => {
    enqueueSpawnPipeline()

    const result = await executeRecurringSchedule(mockSupabase as never, makeSchedule({ auto_send: false }))

    expect(result.invoiceId).toBe('inv-1')
    expect(result.autoSent).toBe(false)
    expect(result.warning).toBeNull()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('auto_send=true sends the email and flips status', async () => {
    enqueueSpawnPipeline()
    enqueue({ data: { company_id: 'company-1', company_name: 'Bolag AB', email: 'bolag@test.se', entity_type: 'aktiebolag' }, error: null }) // company_settings
    enqueue({ data: null, error: null }) // status update
    enqueue({ data: null, error: null }) // journal_entry_id update

    const result = await executeRecurringSchedule(mockSupabase as never, makeSchedule({ auto_send: true }))

    expect(result.autoSent).toBe(true)
    expect(result.warning).toBeNull()
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const options = sendEmailMock.mock.calls[0][0] as { to: string; attachments: Array<{ filename: string }> }
    expect(options.to).toBe('kund@test.se')
    expect(options.attachments[0].filename).toBe('faktura-F-100.pdf')
  })

  it('blocks auto-send with a clear warning when customer email is invalid', async () => {
    const badCustomer = { ...customer, email: 'inte-en-mejl' }
    enqueueSpawnPipeline(badCustomer, { ...completeInvoice, customer: badCustomer })

    const result = await executeRecurringSchedule(mockSupabase as never, makeSchedule({ auto_send: true }))

    expect(result.autoSent).toBe(false)
    expect(result.warning).toContain('e-postadress')
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('blocks auto-send for sandbox companies', async () => {
    isSandboxMock.mockResolvedValue(true)
    enqueueSpawnPipeline()

    const result = await executeRecurringSchedule(mockSupabase as never, makeSchedule({ auto_send: true }))

    expect(result.autoSent).toBe(false)
    expect(result.warning).toContain('Sandlåde')
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('never sends an email without its PDF (render failure blocks send)', async () => {
    renderToBufferMock.mockRejectedValue(new Error('pdf boom'))
    enqueueSpawnPipeline()
    enqueue({ data: { company_id: 'company-1', entity_type: 'aktiebolag' }, error: null }) // company_settings

    const result = await executeRecurringSchedule(mockSupabase as never, makeSchedule({ auto_send: true }))

    expect(result.autoSent).toBe(false)
    expect(result.warning).toContain('PDF')
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('surfaces a warning when the email provider fails', async () => {
    sendEmailMock.mockResolvedValue({ success: false, error: 'provider down' })
    enqueueSpawnPipeline()
    enqueue({ data: { company_id: 'company-1', entity_type: 'aktiebolag' }, error: null }) // company_settings

    const result = await executeRecurringSchedule(mockSupabase as never, makeSchedule({ auto_send: true }))

    expect(result.autoSent).toBe(false)
    expect(result.warning).toContain('E-postleverantören')
  })

  it('surfaces a warning when the email service is unconfigured', async () => {
    isConfiguredMock.mockReturnValue(false)
    enqueueSpawnPipeline()

    const result = await executeRecurringSchedule(mockSupabase as never, makeSchedule({ auto_send: true }))

    expect(result.autoSent).toBe(false)
    expect(result.warning).toContain('E-posttjänsten är inte konfigurerad')
  })

  it('records a partial-failure warning when the journal entry fails after send', async () => {
    createJournalEntryMock.mockRejectedValue(new Error('JE boom'))
    enqueueSpawnPipeline()
    enqueue({ data: { company_id: 'company-1', entity_type: 'aktiebolag' }, error: null }) // company_settings
    enqueue({ data: null, error: null }) // status update

    const result = await executeRecurringSchedule(mockSupabase as never, makeSchedule({ auto_send: true }))

    expect(result.autoSent).toBe(true)
    expect(result.warning).toContain('bokföring')
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
  })
})
