import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'

/**
 * GET /api/documents/counts?journal_entry_ids=id1,id2,...
 * Returns attachment counts per journal entry ID.
 * Max 50 IDs per request.
 */
export async function GET(request: Request) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const idsParam = searchParams.get('journal_entry_ids')

  if (!idsParam) {
    return NextResponse.json({ error: 'journal_entry_ids is required' }, { status: 400 })
  }

  const ids = idsParam.split(',').filter(Boolean)

  if (ids.length === 0) {
    return NextResponse.json({ data: {} })
  }

  if (ids.length > 50) {
    return NextResponse.json({ error: 'Maximum 50 IDs per request' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('document_attachments')
    .select('journal_entry_id')
    .eq('company_id', companyId)
    .eq('is_current_version', true)
    .in('journal_entry_id', ids)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Group and count by journal_entry_id
  const counts: Record<string, number> = {}
  for (const row of data || []) {
    if (row.journal_entry_id) {
      counts[row.journal_entry_id] = (counts[row.journal_entry_id] || 0) + 1
    }
  }

  return NextResponse.json({ data: counts })
}
