import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import {
  assertK2FormalReportModel,
  type K2FormalReportModel,
} from '@/lib/bokslut/formal-report/k2-model'
import { stripAnnualReportControlCharacters } from '@/lib/bokslut/arsredovisning/format'
import { createServiceClient } from '@/lib/supabase/server'

const SnapshotSchema = z.object({
  source_fiscal_period_id: z.string().uuid(),
  source_type: z.enum(['established_annual_report', 'manually_verified']),
  source_label: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .transform(stripAnnualReportControlCharacters),
  formal_report_snapshot: z.unknown(),
  overview_snapshot: z.object({
    year: z.string().trim().min(1).max(50),
    net_revenue: z.number().finite(),
    result_after_financial: z.number().finite(),
    soliditet_pct: z.number().finite().nullable(),
  }),
})

export const GET = withRouteContext(
  'period.arsredovisning_comparatives_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.arsredovisning_comparatives_get',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('previous_period_id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!period) return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      const { data, error } = await supabase
        .from('annual_report_comparative_snapshots')
        .select(
          'id, source_fiscal_period_id, source_version_id, source_type, source_label, overview_snapshot, verified_by, verified_at, created_at',
        )
        .eq('company_id', companyId)
        .eq('source_fiscal_period_id', period.previous_period_id ?? id)
        .is('superseded_at', null)
        .order('verified_at', { ascending: false })
      if (error) throw error
      return NextResponse.json({ data: data ?? [] })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)

export const POST = withRouteContext(
  'period.arsredovisning_comparatives_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, SnapshotSchema)
    if (!validation.success) return validation.response
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.arsredovisning_comparatives_post',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
      const [{ data: currentPeriod }, { data: sourcePeriod }, { data: project }] =
        await Promise.all([
          supabase
            .from('fiscal_periods')
            .select('id, previous_period_id')
            .eq('id', id)
            .eq('company_id', companyId)
            .maybeSingle(),
          supabase
            .from('fiscal_periods')
            .select('id')
            .eq('id', validation.data.source_fiscal_period_id)
            .eq('company_id', companyId)
            .maybeSingle(),
          supabase
            .from('annual_report_projects')
            .select('id, annual_report_locked')
            .eq('company_id', companyId)
            .eq('fiscal_period_id', id)
            .maybeSingle(),
        ])
      if (!currentPeriod || !sourcePeriod) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      if (currentPeriod.previous_period_id !== sourcePeriod.id) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            code: 'COMPARATIVE_PERIOD_MISMATCH',
            reason: 'Jämförelsesnapshoten måste avse föregående räkenskapsår.',
          },
        })
      }
      if (project?.annual_report_locked) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            code: 'ANNUAL_REPORT_LOCKED',
            reason: 'Skapa en ny årsredovisningsversion innan jämförelsetal ändras.',
          },
        })
      }
      assertK2FormalReportModel(
        validation.data.formal_report_snapshot as K2FormalReportModel,
      )
      const serviceDb = createServiceClient()
      const { data, error } = await serviceDb.rpc(
        'replace_annual_report_comparative_snapshot',
        {
          p_company_id: companyId,
          p_source_fiscal_period_id: sourcePeriod.id,
          p_actor_user_id: user.id,
          p_source_type: validation.data.source_type,
          p_source_label: validation.data.source_label,
          p_formal_report_snapshot: validation.data.formal_report_snapshot,
          p_overview_snapshot: [validation.data.overview_snapshot],
          p_source_version_id: null,
        },
      )
      if (error) throw error
      return NextResponse.json({ data }, { status: 201 })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)
