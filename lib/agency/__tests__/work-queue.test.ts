import { describe, it, expect } from 'vitest'
import { buildAgencyWorkQueue, type AgencyClientOverviewRow } from '../work-queue'

const TODAY = new Date('2026-07-01T00:00:00Z')

function row(overrides: Partial<AgencyClientOverviewRow>): AgencyClientOverviewRow {
  return {
    agency_id: 'ag-1',
    company_id: overrides.company_id ?? 'co-1',
    company_name: overrides.company_name ?? 'Klient AB',
    agency_client_status: 'active',
    primary_accountant_name: null,
    bank_status: 'connected',
    review_items_count: 0,
    vat_status: 'ok',
    year_end_status: 'not_started',
    invoice_status: 'ok',
    supplier_invoice_status: 'ok',
    next_deadline_at: null,
    ...overrides,
  }
}

describe('buildAgencyWorkQueue', () => {
  it('excludes clients with nothing to do', () => {
    const queue = buildAgencyWorkQueue([row({})], TODAY)
    expect(queue).toEqual([])
  })

  it('flags overdue deadlines with highest weight', () => {
    const queue = buildAgencyWorkQueue(
      [row({ next_deadline_at: '2026-06-25' })],
      TODAY,
    )
    expect(queue).toHaveLength(1)
    expect(queue[0].items[0].code).toBe('deadline_overdue')
  })

  it('flags imminent deadlines within 14 days but not later ones', () => {
    const imminent = buildAgencyWorkQueue([row({ next_deadline_at: '2026-07-10' })], TODAY)
    expect(imminent[0]?.items[0]?.code).toBe('deadline_imminent')

    const far = buildAgencyWorkQueue([row({ next_deadline_at: '2026-09-01' })], TODAY)
    expect(far).toEqual([])
  })

  it('aggregates multiple issues and sorts clients by urgency', () => {
    const queue = buildAgencyWorkQueue(
      [
        row({ company_id: 'a', company_name: 'Lugn AB', review_items_count: 1 }),
        row({
          company_id: 'b',
          company_name: 'Kris AB',
          next_deadline_at: '2026-06-20',
          review_items_count: 5,
          bank_status: 'not_connected',
          supplier_invoice_status: 'overdue',
        }),
      ],
      TODAY,
    )
    expect(queue).toHaveLength(2)
    expect(queue[0].companyName).toBe('Kris AB')
    expect(queue[0].items.map((i) => i.code)).toEqual(
      expect.arrayContaining(['deadline_overdue', 'review_items', 'bank_not_connected', 'supplier_invoices_overdue']),
    )
  })

  it('skips inactive agency clients', () => {
    const queue = buildAgencyWorkQueue(
      [row({ agency_client_status: 'ended', review_items_count: 9 })],
      TODAY,
    )
    expect(queue).toEqual([])
  })

  it('labels are Swedish', () => {
    const queue = buildAgencyWorkQueue(
      [row({ review_items_count: 2, bank_status: 'not_connected', next_deadline_at: '2026-06-01' })],
      TODAY,
    )
    for (const item of queue[0].items) {
      expect(item.label_sv).toMatch(/granska|Bankkoppling|Deadline|faktur|Moms/i)
    }
  })
})
