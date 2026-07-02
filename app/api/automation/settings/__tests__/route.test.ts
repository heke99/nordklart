import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  emptyRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args),
}))

import { GET, PUT } from '../route'

const mockUser = { id: 'user-1', email: 'admin@test.se' }

const VALID_BODY = {
  bank_transaction_mode: 'auto_safe',
  invoice_payment_matching_mode: 'auto_safe',
  supplier_invoice_matching_mode: 'suggest',
  bank_import_after_sync_mode: 'auto_safe',
  min_auto_confidence: 0.95,
  min_suggestion_confidence: 0.7,
  max_auto_book_amount: 10000,
  allow_auto_customer_invoice_settlement: true,
  allow_auto_supplier_invoice_settlement: false,
  allow_auto_bank_fee_booking: true,
  allow_auto_category_booking: false,
  allow_auto_tax_payment_booking: false,
  allow_auto_salary_payment_booking: false,
}

interface SettingsBody {
  data?: Record<string, unknown> & { defaults?: unknown; success?: boolean }
  error?: string
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  requireWritePermissionMock.mockResolvedValue({ ok: true })
})

describe('GET /api/automation/settings', () => {
  it('returns conservative defaults when no row exists', async () => {
    // loadAutomationSettings does a maybeSingle() on company_automation_settings.
    enqueue({ data: null, error: null })
    const response = await GET(
      createMockRequest('/api/automation/settings'),
      emptyRouteParams(),
    )
    const { status, body } = await parseJsonResponse<SettingsBody>(response)
    expect(status).toBe(200)
    expect(body.data?.bank_transaction_mode).toBe('suggest')
    expect(body.data?.min_auto_confidence).toBe(0.95)
    expect(body.data?.allow_auto_supplier_invoice_settlement).toBe(false)
  })

  it('returns the stored row when present', async () => {
    enqueue({
      data: {
        bank_transaction_mode: 'auto_safe',
        invoice_payment_matching_mode: 'auto_safe',
        supplier_invoice_matching_mode: 'suggest',
        bank_import_after_sync_mode: 'auto_safe',
        min_auto_confidence: '0.9',
        min_suggestion_confidence: '0.6',
        max_auto_book_amount: '5000',
        allow_auto_customer_invoice_settlement: true,
        allow_auto_supplier_invoice_settlement: true,
        allow_auto_bank_fee_booking: true,
        allow_auto_category_booking: true,
        allow_auto_tax_payment_booking: false,
        allow_auto_salary_payment_booking: false,
      },
      error: null,
    })
    const response = await GET(
      createMockRequest('/api/automation/settings'),
      emptyRouteParams(),
    )
    const { status, body } = await parseJsonResponse<SettingsBody>(response)
    expect(status).toBe(200)
    expect(body.data?.bank_transaction_mode).toBe('auto_safe')
    expect(body.data?.min_auto_confidence).toBe(0.9)
    expect(body.data?.max_auto_book_amount).toBe(5000)
    expect(body.data?.allow_auto_supplier_invoice_settlement).toBe(true)
  })
})

describe('PUT /api/automation/settings', () => {
  function putRequest(body: unknown) {
    return PUT(
      createMockRequest('/api/automation/settings', { method: 'PUT', body }),
      emptyRouteParams(),
    )
  }

  it('rejects an invalid mode', async () => {
    const { status } = await parseJsonResponse<SettingsBody>(
      await putRequest({ ...VALID_BODY, bank_transaction_mode: 'yolo' }),
    )
    expect(status).toBe(400)
  })

  it('rejects a suggestion threshold above the auto threshold', async () => {
    const { status, body } = await parseJsonResponse<SettingsBody>(
      await putRequest({
        ...VALID_BODY,
        min_auto_confidence: 0.8,
        min_suggestion_confidence: 0.9,
      }),
    )
    expect(status).toBe(400)
    expect(body.error).toContain('Tröskeln')
  })

  it('rejects an auto threshold below 0.5', async () => {
    const { status } = await parseJsonResponse<SettingsBody>(
      await putRequest({ ...VALID_BODY, min_auto_confidence: 0.3 }),
    )
    expect(status).toBe(400)
  })

  it('upserts the settings for the active company', async () => {
    enqueue({ data: null, error: null })
    const { status, body } = await parseJsonResponse<SettingsBody>(
      await putRequest(VALID_BODY),
    )
    expect(status).toBe(200)
    expect(body.data?.success).toBe(true)
    const upsertCall = mockSupabase.from.mock.calls.find(
      (c: unknown[]) => c[0] === 'company_automation_settings',
    )
    expect(upsertCall).toBeTruthy()
  })

  it('maps an RLS denial to 403 with Swedish copy', async () => {
    enqueue({
      data: null,
      error: { message: 'new row violates row-level security policy' },
    })
    const { status, body } = await parseJsonResponse<SettingsBody>(
      await putRequest(VALID_BODY),
    )
    expect(status).toBe(403)
    expect(body.error).toContain('administratörer')
  })

  it('denies when write permission fails', async () => {
    const { NextResponse } = await import('next/server')
    requireWritePermissionMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    })
    const { status } = await parseJsonResponse<SettingsBody>(await putRequest(VALID_BODY))
    expect(status).toBe(403)
  })
})
