import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { processOverdueReminders } from '@/lib/invoices/reminder-processor'

ensureInitialized()

/**
 * GET /api/invoices/reminders/cron — daily 08:00 UTC.
 *
 * Sends påminnelser for overdue invoices (levels 1/2/3 at 15/30/45 days):
 *   - positive status allowlist (sent / partially_paid / overdue) — disputed,
 *     credited, written_off and collection_ready invoices never match,
 *   - per-company kill switch (company_settings.send_invoice_reminders),
 *   - level dedup via invoice_reminders (each level sent at most once),
 *   - customers who already responded via the public action link are skipped,
 *   - lagstadgad påminnelseavgift (max 60 kr, Lag 1981:739) is booked and
 *     dröjsmålsränta (Räntelagen 6 §) computed per reminder,
 *   - action tokens are generated per reminder with expiry; tokens are never
 *     logged (only the reminder row id is).
 *
 * Idempotency: determineReminderLevel() only returns a level that has no
 * existing invoice_reminders row, so a cron retry can never double-send.
 */
export const GET = withCronContext('cron.invoice_reminders', async (_request, ctx) => {
  const result = await processOverdueReminders()

  ctx.log.info('invoice reminder run finished', {
    processed: result.processed,
    sent: result.sent,
    failed: result.failed,
  })

  return NextResponse.json({
    processed: result.processed,
    sent: result.sent,
    failed: result.failed,
  })
})

export const POST = GET
