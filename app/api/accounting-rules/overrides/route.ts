import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'

const CreateManualOverrideSchema = z.object({
  rule_decision_id: z.string().uuid().nullable().optional(),
  source_type: z.string().min(1),
  source_id: z.string().uuid().nullable().optional(),
  field_name: z.string().min(1),
  old_value: z.unknown().optional(),
  new_value: z.unknown(),
  risk_level: z.enum(['low', 'medium', 'high', 'locked_period_correction']),
  reason: z.string().min(1).optional(),
  evidence_document_id: z.string().uuid().nullable().optional(),
})

export const POST = withRouteContext(
  'accounting_rules.override',
  async (request, ctx) => {
    const { supabase, companyId, user } = ctx
    const validation = await validateBody(request, CreateManualOverrideSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    if ((body.risk_level === 'high' || body.risk_level === 'locked_period_correction') && !body.reason?.trim()) {
      return NextResponse.json(
        { error: { code: 'OVERRIDE_REASON_REQUIRED', message: 'Högriskändringar kräver kommentar så ändringen kan följas upp.' } },
        { status: 422 },
      )
    }

    const { data, error } = await supabase
      .from('accounting_manual_overrides')
      .insert({
        company_id: companyId,
        user_id: user.id,
        rule_decision_id: body.rule_decision_id ?? null,
        source_type: body.source_type,
        source_id: body.source_id ?? null,
        field_name: body.field_name,
        old_value: body.old_value ?? null,
        new_value: body.new_value,
        risk_level: body.risk_level,
        reason: body.reason ?? null,
        evidence_document_id: body.evidence_document_id ?? null,
      })
      .select('*')
      .single()

    if (error) throw new Error(`Kunde inte spara manuell ändring: ${error.message}`)
    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
