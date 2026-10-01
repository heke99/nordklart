import type { z } from 'zod'
import type { RecurringScheduleItemSchema } from '@/lib/api/schemas'

/** Shape replace_recurring_schedule_items() reads for one template line. */
export function toItemPayload(item: z.infer<typeof RecurringScheduleItemSchema>) {
  return {
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    vat_rate: item.vat_rate ?? null,
    article_id: item.article_id ?? null,
    revenue_account: item.revenue_account ?? null,
    valid_from: item.valid_from ?? null,
    valid_until: item.valid_until ?? null,
    remaining_occurrences: item.remaining_occurrences ?? null,
  }
}
