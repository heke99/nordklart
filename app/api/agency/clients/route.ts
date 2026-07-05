import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveCompanyAccess } from '@/lib/access/company'
import { assertAgencyClientCapacity, resolveManageableAgency } from '@/lib/agency/commercial'

const CreateAgencyClientSchema = z.object({
  agency_id: z.string().uuid().optional(),
  company_id: z.string().uuid(),
  access_level: z.enum(['bookkeeping', 'review', 'audit', 'full_service']).default('bookkeeping'),
  billing_owner: z.enum(['agency', 'client', 'shared']).default('agency'),
  primary_accountant_id: z.string().uuid().nullable().optional(),
  status: z.enum(['pending', 'active']).default('pending'),
})

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = CreateAgencyClientSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ogiltig begäran.', issues: parsed.error.flatten() }, { status: 400 })
  }

  const agencyAccess = await resolveManageableAgency(supabase, user.id, parsed.data.agency_id ?? null)
  if (!agencyAccess.ok) return agencyAccess.response

  const capacity = await assertAgencyClientCapacity(supabase, agencyAccess.agencyCompanyId)
  if (!capacity.ok) return capacity.response

  // Tenant consent: an active link grants the whole agency access to the
  // client company's books, so activating requires the caller to manage the
  // client company (agency-created workspaces). Foreign companies start as
  // 'pending' and must be approved by the client company's owner/admin.
  // RLS on agency_clients enforces the same rule — this check exists to
  // return a clear Swedish error instead of a generic RLS denial.
  if (parsed.data.status === 'active') {
    const clientAccess = await resolveCompanyAccess(supabase, parsed.data.company_id)
    if (!clientAccess?.canManageCompany) {
      return NextResponse.json(
        {
          error:
            'Kopplingen kan inte aktiveras direkt. Skapa den som väntande — kundbolagets ägare eller administratör måste godkänna byråns åtkomst.',
        },
        { status: 403 },
      )
    }
  }

  const { data: existing, error: existingError } = await supabase
    .from('agency_clients')
    .select('id, status')
    .eq('agency_id', agencyAccess.agencyId)
    .eq('company_id', parsed.data.company_id)
    .maybeSingle()

  if (existingError) {
    return NextResponse.json({ error: 'Kundrelationen kunde inte kontrolleras.' }, { status: 500 })
  }
  if (existing) {
    return NextResponse.json({ error: 'Kundbolaget är redan kopplat till byrån.', id: existing.id, status: existing.status }, { status: 409 })
  }

  const { data, error } = await supabase
    .from('agency_clients')
    .insert({
      agency_id: agencyAccess.agencyId,
      company_id: parsed.data.company_id,
      status: parsed.data.status,
      access_level: parsed.data.access_level,
      billing_owner: parsed.data.billing_owner,
      primary_accountant_id: parsed.data.primary_accountant_id ?? null,
      created_by: user.id,
      approved_by_client_user_id: parsed.data.status === 'active' ? user.id : null,
      approved_at: parsed.data.status === 'active' ? new Date().toISOString() : null,
      relationship_metadata: { created_via: 'agency_clients_api' },
    })
    .select('id, agency_id, company_id, status, access_level, billing_owner')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message || 'Kundrelationen kunde inte skapas.' }, { status: 500 })
  }

  return NextResponse.json({ data }, { status: 201 })
}
