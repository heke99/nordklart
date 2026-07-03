/**
 * Agency work queue — ranks byrå clients by what needs a consultant's
 * attention. Pure aggregation over agency_client_overview_v rows so it is
 * unit-testable and reusable (dashboard + API).
 */

export interface AgencyClientOverviewRow {
  agency_id: string
  company_id: string
  company_name: string
  agency_client_status?: string | null
  primary_accountant_name?: string | null
  bank_status: string | null
  review_items_count: number | null
  vat_status: string | null
  year_end_status: string | null
  invoice_status: string | null
  supplier_invoice_status: string | null
  bankgiro_status?: string | null
  next_deadline_at: string | null
}

export interface WorkQueueItem {
  code:
    | 'deadline_overdue'
    | 'deadline_imminent'
    | 'review_items'
    | 'bank_not_connected'
    | 'invoices_overdue'
    | 'supplier_invoices_overdue'
    | 'vat_blocked'
  label_sv: string
  weight: number
}

export interface AgencyWorkQueueEntry {
  companyId: string
  companyName: string
  primaryAccountantName: string | null
  urgency: number
  items: WorkQueueItem[]
  nextDeadlineAt: string | null
}

const DEADLINE_IMMINENT_DAYS = 14

/**
 * Compute per-client attention items and an urgency score. Clients with no
 * items are excluded. Sorted most-urgent first, name as tiebreak.
 */
export function buildAgencyWorkQueue(
  rows: AgencyClientOverviewRow[],
  today: Date = new Date(),
): AgencyWorkQueueEntry[] {
  const todayMs = today.getTime()
  const entries: AgencyWorkQueueEntry[] = []

  for (const row of rows) {
    if (row.agency_client_status && row.agency_client_status !== 'active') continue
    const items: WorkQueueItem[] = []

    if (row.next_deadline_at) {
      const dueMs = new Date(`${row.next_deadline_at.slice(0, 10)}T00:00:00Z`).getTime()
      const diffDays = Math.floor((dueMs - todayMs) / 86_400_000)
      if (diffDays < 0) {
        items.push({
          code: 'deadline_overdue',
          label_sv: `Deadline passerad (${row.next_deadline_at.slice(0, 10)})`,
          weight: 100,
        })
      } else if (diffDays <= DEADLINE_IMMINENT_DAYS) {
        items.push({
          code: 'deadline_imminent',
          label_sv: `Deadline om ${diffDays} dag${diffDays === 1 ? '' : 'ar'} (${row.next_deadline_at.slice(0, 10)})`,
          weight: 60,
        })
      }
    }

    const reviewCount = row.review_items_count ?? 0
    if (reviewCount > 0) {
      items.push({
        code: 'review_items',
        label_sv: `${reviewCount} ärende${reviewCount === 1 ? '' : 'n'} att granska`,
        weight: 40 + Math.min(reviewCount, 20),
      })
    }

    if (row.bank_status && row.bank_status !== 'connected') {
      items.push({
        code: 'bank_not_connected',
        label_sv: 'Bankkoppling saknas eller har gått ut',
        weight: 30,
      })
    }

    if (row.invoice_status === 'overdue') {
      items.push({ code: 'invoices_overdue', label_sv: 'Förfallna kundfakturor', weight: 20 })
    }
    if (row.supplier_invoice_status === 'overdue') {
      items.push({
        code: 'supplier_invoices_overdue',
        label_sv: 'Förfallna leverantörsfakturor',
        weight: 25,
      })
    }
    if (row.vat_status === 'blocked' || row.vat_status === 'overdue') {
      items.push({ code: 'vat_blocked', label_sv: 'Momsdeklaration kräver åtgärd', weight: 70 })
    }

    if (items.length === 0) continue

    entries.push({
      companyId: row.company_id,
      companyName: row.company_name,
      primaryAccountantName: row.primary_accountant_name ?? null,
      urgency: items.reduce((sum, item) => sum + item.weight, 0),
      items: items.toSorted((a, b) => b.weight - a.weight),
      nextDeadlineAt: row.next_deadline_at,
    })
  }

  return entries.toSorted(
    (a, b) => b.urgency - a.urgency || a.companyName.localeCompare(b.companyName, 'sv'),
  )
}
