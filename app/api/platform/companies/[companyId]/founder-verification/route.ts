import { NextResponse } from 'next/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'

const log = createLogger('platform-founder-verification')

const BodySchema = z.object({
  user_id: z.string().uuid(),
  decision: z.enum(['verified', 'rejected']),
  note: z.string().trim().min(3).max(1000),
})

/**
 * POST /api/platform/companies/[companyId]/founder-verification
 *
 * A platform admin decides on a founder whose BankID identity could not be
 * matched to the company in Bolagsverket's register (verification_status
 * 'manual_review', membership 'active_limited'). 'verified' gives full owner
 * access; 'rejected' suspends the membership. The database re-checks the
 * platform_admin role and writes the audit event in the same transaction.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const auth = await requireAuth()
  if (auth.error) return auth.error

  const { data: role } = await auth.supabase
    .from('platform_roles')
    .select('role')
    .eq('user_id', auth.user.id)
    .eq('role', 'platform_admin')
    .is('revoked_at', null)
    .limit(1)
    .maybeSingle()
  if (!role) return errorResponseFromCode('FORBIDDEN', log, { messageSv: 'Forbidden', status: 403 })

  const { companyId } = await params
  if (!z.string().uuid().safeParse(companyId).success) {
    return errorResponseFromCode('VALIDATION_ERROR', log, { messageSv: 'Ogiltigt företags-id.', status: 400 })
  }
  const parsed = BodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', log, { messageSv: 'Ogiltig begäran.', status: 400 })

  const { data, error } = await createServiceClient().rpc('platform_decide_founder_verification', {
    p_company_id: companyId,
    p_user_id: parsed.data.user_id,
    p_decision: parsed.data.decision,
    p_actor: auth.user.id,
    p_note: parsed.data.note,
  })

  if (error?.code === '55000') {
    return errorResponseFromCode('CONFLICT', log, { messageSv: 'Ingen grundare väntar på granskning i bolaget.', status: 409 })
  }
  if (error?.code === '42501') return errorResponseFromCode('FORBIDDEN', log, { messageSv: 'Forbidden', status: 403 })
  if (error) return errorResponseFromCode('INTERNAL_ERROR', log, { messageSv: 'Beslutet kunde inte sparas.', status: 500 })

  return NextResponse.json({ data: { decision: data } })
}
