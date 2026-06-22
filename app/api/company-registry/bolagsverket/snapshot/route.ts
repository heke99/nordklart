import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'
import { createServiceClient } from '@/lib/supabase/server'
import { getLatestBolagsverketSnapshot } from '@/lib/company-registry/registry-service'

export async function GET() {
  const { user, supabase, error: authError } = await requireAuth()
  if (authError) return authError

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) {
    return NextResponse.json({ error: 'Inget aktivt företag.' }, { status: 403 })
  }

  const service = createServiceClient()
  const snapshot = await getLatestBolagsverketSnapshot(service, companyId)
  return NextResponse.json({ snapshot })
}
