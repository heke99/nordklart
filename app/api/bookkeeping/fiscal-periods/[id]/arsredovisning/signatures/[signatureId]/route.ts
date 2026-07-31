import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'

// PATCH transitions: pending → signed (manual entry for the paper / outside-
// BankID flow) or pending → declined. Real BankID wiring lands in a future
// phase and uses the same UPDATE with the BankID callback as trigger.
//
// Hardening on every UPDATE:
//   - .eq('id', signatureId) + .eq('company_id', companyId)
//   - .eq('fiscal_period_id', id from URL) — enforces the REST contract so
//     /periods/A/signatures/SIG_FROM_B can't bypass the path scope
//   - .eq('status', 'pending') — state-machine guard so a signed or declined
//     row can't be flipped back
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00.000Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  })

const PatchSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('signed'), signed_at: isoDate }),
  z.object({ status: z.literal('declined') }),
])

export const PATCH = withRouteContext(
  'period.arsredovisning_signature_patch',
  async (
    request,
    ctx,
    { params }: { params: Promise<{ id: string; signatureId: string }> },
  ) => {
    const { id: fiscalPeriodId, signatureId } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, PatchSchema)
    if (!validation.success) return validation.response

    const update =
      validation.data.status === 'signed'
        ? {
            status: 'signed' as const,
            signed_at: `${validation.data.signed_at}T12:00:00.000Z`,
          }
        : { status: 'declined' as const }

    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, fiscalPeriodId, {
        operation: 'period.arsredovisning_signature_patch',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const { data: project } = await supabase
        .from('annual_report_projects')
        .select('annual_report_locked')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .maybeSingle()
      if (project?.annual_report_locked) {
        return NextResponse.json(
          {
            error: {
              code: 'ANNUAL_REPORT_LOCKED',
              message: 'Slutversionen är låst. Skapa en ny version innan underskrifter ändras.',
            },
          },
          { status: 409 },
        )
      }

      const { data, error } = await supabase
        .from('arsredovisning_signature_requests')
        .update(update)
        .eq('id', signatureId)
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('status', 'pending')
        .select('*')
        .maybeSingle()

      if (error) {
        throw new Error(`Failed to update signature: ${error.message}`)
      }
      if (!data) {
        // No row matched: either it doesn't exist, belongs to another
        // company / period, or is already signed/declined. Return 409 so
        // the client knows the transition is invalid rather than "missing".
        return NextResponse.json(
          { error: { code: 'SIGNATURE_INVALID_TRANSITION' } },
          { status: 409 },
        )
      }
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)
