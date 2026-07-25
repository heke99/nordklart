import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { generateINK2Declaration } from '@/lib/reports/ink2/ink2-engine'
import { generateNEDeclaration } from '@/lib/reports/ne-bilaga/ne-engine'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { listTaxDeclarationAdjustments, upsertTaxDeclarationProject } from '@/lib/tax-declaration/adjustments'

const AdjustmentSchema = z.object({
  declaration_type: z.enum(['INK2', 'NE']).default('INK2'),
  form: z.string().min(2).max(20).default('INK2S'),
  field_code: z.string().regex(/^\d{4}$/),
  amount: z.number().finite(),
  description: z.string().max(500).nullable().optional(),
  source: z.enum(['auto', 'account_rule', 'user_input', 'imported', 'calculated']).default('user_input'),
  confidence: z.number().min(0).max(1).nullable().optional(),
  requires_review: z.boolean().default(false),
  approved: z.boolean().default(true),
})

const AnswerSchema = z.object({
  declaration_type: z.enum(['INK2', 'NE']).default('INK2'),
  question_key: z.string().min(2).max(120),
  answer: z.unknown(),
  requires_review: z.boolean().default(false),
})

const PostSchema = z.object({
  declaration_type: z.enum(['INK2', 'NE']).default('INK2'),
  adjustments: z.array(AdjustmentSchema).default([]),
  answers: z.array(AnswerSchema).default([]),
})

export const GET = withRouteContext(
  'tax_declaration.project_get',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const declarationType = (new URL(request.url).searchParams.get('type') === 'NE' ? 'NE' : 'INK2') as 'INK2' | 'NE'

    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'tax_declaration.project_get',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const declaration = declarationType === 'NE'
        ? await generateNEDeclaration(supabase, companyId, id)
        : await generateINK2Declaration(supabase, companyId, id)
      const adjustments = await listTaxDeclarationAdjustments(supabase, companyId, id, declarationType)

      return NextResponse.json({
        data: {
          declaration_type: declarationType,
          declaration,
          adjustments,
          readiness: declaration.taxAnalysis ?? null,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      return errorResponse(err, log, { requestId })
    }
  },
)

export const POST = withRouteContext(
  'tax_declaration.project_update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, PostSchema)
    if (!validation.success) return validation.response

    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'tax_declaration.project_update',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const payload = validation.data
      const projectId = await upsertTaxDeclarationProject(
        supabase,
        companyId,
        id,
        payload.declaration_type,
        user.id,
        'needs_review',
        0,
        [],
        [],
      )

      if (!projectId) {
        return NextResponse.json({ error: 'TAX_DECLARATION_PROJECT_NOT_AVAILABLE' }, { status: 503 })
      }

      if (payload.adjustments.length) {
        const rows = payload.adjustments.map((item) => ({
          company_id: companyId,
          fiscal_period_id: id,
          tax_declaration_project_id: projectId,
          declaration_type: item.declaration_type,
          form: item.form,
          field_code: item.field_code,
          amount: item.amount,
          description: item.description ?? null,
          source: item.source,
          confidence: item.confidence ?? null,
          requires_review: item.requires_review,
          approved_by: item.approved ? user.id : null,
          approved_at: item.approved ? new Date().toISOString() : null,
          created_by: user.id,
          updated_at: new Date().toISOString(),
        }))
        const { error } = await supabase.from('tax_declaration_adjustments').insert(rows)
        if (error) throw error
      }

      if (payload.answers.length) {
        const rows = payload.answers.map((item) => ({
          company_id: companyId,
          fiscal_period_id: id,
          tax_declaration_project_id: projectId,
          declaration_type: item.declaration_type,
          question_key: item.question_key,
          answer: item.answer,
          requires_review: item.requires_review,
          answered_by: user.id,
          answered_at: new Date().toISOString(),
        }))
        const { error } = await supabase
          .from('tax_declaration_questionnaire_answers')
          .upsert(rows, { onConflict: 'company_id,fiscal_period_id,declaration_type,question_key' })
        if (error) throw error
      }

      return NextResponse.json({ data: { project_id: projectId } })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
