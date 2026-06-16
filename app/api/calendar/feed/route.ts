import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import type { UpdateCalendarFeedInput } from '@/types'

/**
 * GET /api/calendar/feed
 * Get current user's calendar feed settings
 */
export async function GET() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { data: feed, error } = await supabase
    .from('calendar_feeds')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = no rows returned, which is fine
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Generate the feed URL
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.nordklart.se'

  if (feed) {
    return NextResponse.json({
      data: {
        ...feed,
        // Generate webcal:// URL for Apple Calendar
        webcalUrl: `webcal://${baseUrl.replace(/^https?:\/\//, '')}/api/calendar/feed/${feed.feed_token}`,
        // Generate https:// URL for other calendars
        httpsUrl: `${baseUrl}/api/calendar/feed/${feed.feed_token}`,
      },
    })
  }

  return NextResponse.json({ data: null })
}

/**
 * POST /api/calendar/feed
 * Create a new calendar feed for the current user
 */
export async function POST() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Check if feed already exists
  const { data: existingFeed } = await supabase
    .from('calendar_feeds')
    .select('id')
    .eq('company_id', companyId)
    .single()

  if (existingFeed) {
    return NextResponse.json(
      { error: 'Calendar feed already exists' },
      { status: 409 }
    )
  }

  // Create new feed
  const { data: feed, error } = await supabase
    .from('calendar_feeds')
    .insert({
      user_id: user.id,
      company_id: companyId,
      is_active: true,
      include_tax_deadlines: true,
      include_invoices: true,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.nordklart.se'

  return NextResponse.json({
    data: {
      ...feed,
      webcalUrl: `webcal://${baseUrl.replace(/^https?:\/\//, '')}/api/calendar/feed/${feed.feed_token}`,
      httpsUrl: `${baseUrl}/api/calendar/feed/${feed.feed_token}`,
    },
  })
}

/**
 * PUT /api/calendar/feed
 * Update calendar feed settings
 */
export async function PUT(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const body: UpdateCalendarFeedInput = await request.json()

  const { data: feed, error } = await supabase
    .from('calendar_feeds')
    .update(body)
    .eq('company_id', companyId)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.nordklart.se'

  return NextResponse.json({
    data: {
      ...feed,
      webcalUrl: `webcal://${baseUrl.replace(/^https?:\/\//, '')}/api/calendar/feed/${feed.feed_token}`,
      httpsUrl: `${baseUrl}/api/calendar/feed/${feed.feed_token}`,
    },
  })
}

/**
 * DELETE /api/calendar/feed
 * Regenerate calendar feed token (invalidates old URL)
 */
export async function DELETE() {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Generate a new token by updating with a new UUID
  const { data: feed, error } = await supabase
    .from('calendar_feeds')
    .update({
      feed_token: crypto.randomUUID(),
      access_count: 0,
      last_accessed_at: null,
    })
    .eq('company_id', companyId)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.nordklart.se'

  return NextResponse.json({
    data: {
      ...feed,
      webcalUrl: `webcal://${baseUrl.replace(/^https?:\/\//, '')}/api/calendar/feed/${feed.feed_token}`,
      httpsUrl: `${baseUrl}/api/calendar/feed/${feed.feed_token}`,
    },
  })
}
