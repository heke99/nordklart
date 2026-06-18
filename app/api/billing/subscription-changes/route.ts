import { NextResponse } from 'next/server'
import { z } from 'zod'
import { canManageCompanyBilling } from '@/lib/billing/access'
import { getActiveCompanyId } from '@/lib/company/context'
import { requireAuth } from '@/lib/auth/require-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RequestSchema = z.discriminatedUnion('requestType', [
  z.object({ subscriptionId: z.string().uuid(), requestType: z.literal('change_plan'), targetPlanVersionId: z.string().uuid(), note: z.string().trim().max(1000).optional() }),
  z.object({ subscriptionId: z.string().uuid(), requestType: z.literal('cancel_subscription'), note: z.string().trim().max(1000).optional() }),
])

export async function POST(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { supabase, user } = auth
  const payload = RequestSchema.safeParse(await request.json().catch(() => ({})))
  if (!payload.success) return NextResponse.json({ error: 'Kontrollera abonnemangsändringen och försök igen.' }, { status: 422 })

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId || !await canManageCompanyBilling(supabase, user.id, companyId)) {
    return NextResponse.json({ error: 'Endast företagets ägare eller administratör kan begära abonnemangsändringar.' }, { status: 403 })
  }

  const { data: subscription } = await supabase
    .from('company_subscriptions')
    .select('id')
    .eq('id', payload.data.subscriptionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!subscription) return NextResponse.json({ error: 'Abonnemanget kunde inte hittas för företaget.' }, { status: 404 })

  const { data: requestId, error } = await supabase.rpc('company_request_subscription_change', {
    p_subscription_id: payload.data.subscriptionId,
    p_request_type: payload.data.requestType,
    p_target_plan_version_id: payload.data.requestType === 'change_plan' ? payload.data.targetPlanVersionId : null,
    p_customer_note: payload.data.note || null,
  })
  if (error || !requestId) return NextResponse.json({ error: error?.message || 'Ändringen kunde inte registreras.' }, { status: 409 })

  return NextResponse.json({ requestId, message: 'Din begäran är registrerad och hanteras av Nordklart.' }, { status: 201 })
}
