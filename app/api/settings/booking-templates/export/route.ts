import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'

/**
 * GET /api/settings/booking-templates/export
 * Export company + team templates as JSON (excludes system templates).
 * Useful for sharing templates between unrelated companies.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const { data, error } = await supabase
    .from('booking_template_library')
    .select('name, description, category, entity_type, lines')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .eq('is_system', false)
    .order('category')
    .order('name')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return new NextResponse(JSON.stringify({ version: 1, templates: data }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="bokforingsmallar.json"',
    },
  })
}
