import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { buildArsredovisningData } from '@/lib/bokslut/arsredovisning/build-data'
import { K2_BR_MAPPINGS } from '@/lib/bokslut/ixbrl/k2-mapper'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { stripAnnualReportControlCharacters } from '@/lib/bokslut/arsredovisning/format'
import { createServiceClient } from '@/lib/supabase/server'

const CreateSchema = z.object({
  account_number: z.string().regex(/^[0-9]{4}$/),
  target_concept: z.string().trim().min(3).max(150),
  target_presentation: z.string().trim().min(3).max(200).transform(stripAnnualReportControlCharacters),
  amount: z.number().positive().finite(),
  reason: z.string().trim().min(10).max(2000).transform(stripAnnualReportControlCharacters),
})

const RevokeSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().min(10).max(1000).transform(stripAnnualReportControlCharacters),
})

function conceptForAccount(accountNumber: string): string | null {
  return (
    K2_BR_MAPPINGS.find((mapping) =>
      mapping.ranges.some(
        (range) => accountNumber >= range.start && accountNumber <= range.end,
      ),
    )?.concept ?? null
  )
}

export const GET = withRouteContext(
  'period.arsredovisning_reclassifications_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.arsredovisning_reclassifications_get',
        requestId,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
      const { data, error } = await supabase
        .from('annual_report_presentation_reclassifications')
        .select(
          'id, account_number, source_concept, target_concept, original_presentation, target_presentation, amount, reason, created_by, created_at, revoked_by, revoked_at',
        )
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .order('created_at')
      if (error) throw error
      return NextResponse.json({ data: data ?? [] })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true },
)

export const POST = withRouteContext(
  'period.arsredovisning_reclassifications_post',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, CreateSchema)
    if (!validation.success) return validation.response
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.arsredovisning_reclassifications_post',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!period) return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })

      await supabase.from('annual_report_projects').upsert(
        {
          company_id: companyId,
          fiscal_period_id: id,
          status: 'draft',
          annual_report_locked: false,
          submission_blocked: true,
          created_by: user.id,
          updated_by: user.id,
        },
        { onConflict: 'company_id,fiscal_period_id', ignoreDuplicates: true },
      )
      const { data: project, error: projectError } = await supabase
        .from('annual_report_projects')
        .select('id, annual_report_locked')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .single()
      if (projectError) throw projectError
      if (project.annual_report_locked) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            code: 'ANNUAL_REPORT_LOCKED',
            reason: 'Skapa en ny årsredovisningsversion innan presentationen ändras.',
          },
        })
      }

      const sourceConcept = conceptForAccount(validation.data.account_number)
      if (!sourceConcept) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: { code: 'ACCOUNT_NOT_MAPPED_TO_K2', account_number: validation.data.account_number },
        })
      }
      if (sourceConcept === validation.data.target_concept) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: { code: 'RECLASSIFICATION_SOURCE_EQUALS_TARGET' },
        })
      }

      const [annualReport, trialBalance] = await Promise.all([
        buildArsredovisningData(supabase, companyId, id),
        generateTrialBalance(supabase, companyId, id),
      ])
      const model = annualReport.formal_report
      const account = trialBalance.rows.find(
        (row) => row.account_number === validation.data.account_number,
      )
      const sourceAmount = model?.br[sourceConcept]?.current
      const targetAmount = model?.br[validation.data.target_concept]?.current
      const sourceNode = model?.nodes.find((node) => node.taxonomyConcept === sourceConcept)
      const targetNode = model?.nodes.find(
        (node) => node.taxonomyConcept === validation.data.target_concept,
      )
      if (!model || sourceAmount == null || targetAmount == null || !account) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: { code: 'RECLASSIFICATION_SOURCE_NOT_AVAILABLE' },
        })
      }
      if (
        sourceNode?.balanceSide !== 'equity_liabilities' ||
        targetNode?.balanceSide !== 'assets'
      ) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            code: 'RECLASSIFICATION_MUST_MOVE_NEGATIVE_LIABILITY_TO_ASSET',
            source_concept: sourceConcept,
            source_side: sourceNode?.balanceSide ?? null,
            target_concept: validation.data.target_concept,
            target_side: targetNode?.balanceSide ?? null,
          },
        })
      }

      const abnormalDebit = Number(account.closing_debit) - Number(account.closing_credit)
      if (abnormalDebit <= 0 || sourceAmount >= 0) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            code: 'ACCOUNT_BALANCE_DIRECTION_NOT_ABNORMAL',
            account_number: account.account_number,
            closing_debit: account.closing_debit,
            closing_credit: account.closing_credit,
          },
        })
      }
      if (validation.data.amount > Math.min(abnormalDebit, Math.abs(sourceAmount)) + 0.005) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: {
            code: 'RECLASSIFICATION_AMOUNT_EXCEEDS_ABNORMAL_BALANCE',
            maximum_amount: Math.min(abnormalDebit, Math.abs(sourceAmount)),
          },
        })
      }

      const serviceDb = createServiceClient()
      const { data, error } = await serviceDb
        .from('annual_report_presentation_reclassifications')
        .insert({
          project_id: project.id,
          company_id: companyId,
          fiscal_period_id: id,
          account_number: validation.data.account_number,
          source_concept: sourceConcept,
          target_concept: validation.data.target_concept,
          original_presentation: sourceConcept,
          target_presentation: validation.data.target_presentation,
          amount: validation.data.amount,
          reason: validation.data.reason,
          creates_journal_entry: false,
          created_by: user.id,
        })
        .select('id, account_number, source_concept, target_concept, amount, reason, created_at')
        .single()
      if (error) throw error
      return NextResponse.json({ data }, { status: 201 })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true, requireWrite: true },
)

export const DELETE = withRouteContext(
  'period.arsredovisning_reclassifications_delete',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, RevokeSchema)
    if (!validation.success) return validation.response
    try {
      const access = await requireYearEndAccess(supabase, companyId, user.id, id, {
        operation: 'period.arsredovisning_reclassifications_delete',
        requestId,
        requireWrite: true,
      })
      if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)
      const { data: project } = await supabase
        .from('annual_report_projects')
        .select('id, annual_report_locked')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .maybeSingle()
      if (project?.annual_report_locked) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: { code: 'ANNUAL_REPORT_LOCKED' },
        })
      }
      const serviceDb = createServiceClient()
      const { data, error } = await serviceDb
        .from('annual_report_presentation_reclassifications')
        .update({
          revoked_by: user.id,
          revoked_at: new Date().toISOString(),
          revocation_reason: validation.data.reason,
        })
        .eq('id', validation.data.id)
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .is('revoked_at', null)
        .select('id, account_number, source_concept, target_concept, amount')
        .maybeSingle()
      if (error) throw error
      if (!data) return errorResponseFromCode('NOT_FOUND', log, { requestId })
      return NextResponse.json({ data: { id: data.id, revoked: true } })
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  },
  { allowRequestedCompany: true, requireWrite: true },
)
