import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Activates due, already-published plan versions without exposing a public mutation path. */
export const GET = withCronContext('commerce.activate_scheduled_prices', async (_request, ctx) => {
  const service = createServiceClient()
  const { data, error } = await service
    .rpc('platform_activate_due_price_plan_versions')
    .throwOnError()

  if (error) throw error
  const activated = Array.isArray(data) ? Number(data[0]?.activated_count ?? 0) : 0
  ctx.log.info('scheduled price versions activated', { activated })
  return NextResponse.json({ success: true, activated })
})
