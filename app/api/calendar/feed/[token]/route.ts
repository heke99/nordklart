import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { generateCalendarFeed } from '@/lib/calendar/ics-generator'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'

/**
 * GET /api/calendar/feed/[token]
 * Returns an ICS calendar feed for the given token
 * No authentication required - the token IS the authentication
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  // Validate token format (UUID)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(token)) {
    return new NextResponse('Invalid token', { status: 400 })
  }

  // Per token, durably: the in-memory map this replaced did nothing on
  // serverless, where every request may land on a fresh instance.
  const limit = await checkDurableRateLimit({
    prefix: 'calendar:feed',
    identifier: token,
    maxRequests: 60,
    windowMs: 60_000,
  })
  if (!limit.ok) return new NextResponse('Too many requests', { status: 429 })

  // Create service client (no user auth required)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return new NextResponse('Server configuration error', { status: 500 })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  // Fetch feed settings by token
  const { data: feed, error: feedError } = await supabase
    .from('calendar_feeds')
    .select('*')
    .eq('feed_token', token)
    .eq('is_active', true)
    .single()

  if (feedError || !feed) {
    return new NextResponse('Feed not found or inactive', { status: 404 })
  }

  // Check token expiry
  if (feed.expires_at && new Date(feed.expires_at) < new Date()) {
    return new NextResponse('Feed token has expired', { status: 410 })
  }

  // The token is a bearer credential of the user who created it. It stops
  // working when that user loses access to the company (removed member,
  // deleted account), like an API key does.
  const { data: ownerActive } = await supabase.rpc('api_key_owner_is_active', {
    p_user_id: feed.user_id,
    p_company_id: feed.company_id,
  })
  if (ownerActive !== true) {
    return new NextResponse('Feed not found or inactive', { status: 404 })
  }

  // Update access tracking
  await supabase
    .from('calendar_feeds')
    .update({
      last_accessed_at: new Date().toISOString(),
      access_count: feed.access_count + 1,
    })
    .eq('id', feed.id)

  // Calculate date range: 3 months back, 12 months forward
  const now = new Date()
  const startDate = new Date(now)
  startDate.setMonth(startDate.getMonth() - 3)
  const endDate = new Date(now)
  endDate.setMonth(endDate.getMonth() + 12)

  const startStr = startDate.toISOString().split('T')[0]
  const endStr = endDate.toISOString().split('T')[0]

  // Fetch relevant data based on feed options
  const [deadlinesResult, invoicesResult] = await Promise.all([
    // Deadlines
    feed.include_tax_deadlines
      ? supabase
          .from('deadlines')
          .select('*')
          .eq('company_id', feed.company_id)
          .gte('due_date', startStr)
          .lte('due_date', endStr)
          .order('due_date')
      : { data: [] },

    // Invoices
    feed.include_invoices
      ? supabase
          .from('invoices')
          .select('*, customer:customers(*)')
          .eq('company_id', feed.company_id)
          .gte('due_date', startStr)
          .lte('due_date', endStr)
          .order('due_date')
      : { data: [] },
  ])

  try {
    const icsContent = await generateCalendarFeed(
      {
        deadlines: deadlinesResult.data || [],
        invoices: invoicesResult.data || [],
      },
      {
        includeTaxDeadlines: feed.include_tax_deadlines,
        includeInvoices: feed.include_invoices,
      }
    )

    return new NextResponse(icsContent, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="nordklart.ics"',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    })
  } catch (error) {
    console.error('Error generating ICS feed:', error)
    return new NextResponse('Failed to generate calendar feed', { status: 500 })
  }
}
