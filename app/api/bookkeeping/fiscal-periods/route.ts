import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { validateBody } from '@/lib/api/validate'
import { CreateFiscalPeriodSchema } from '@/lib/api/schemas'
import { getActiveCompanyId } from '@/lib/company/context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'
import {
  auditPlatformFiscalPeriodOperation,
  resolveFiscalPeriodAccess,
} from '@/lib/year-end/period-access'

const log = createLogger('api/bookkeeping/fiscal-periods')
const CompanyIdSchema = z.string().uuid()

function requestId(): string {
  return `req_${crypto.randomUUID()}`
}

async function resolveRequestedCompanyId(
  request: Request,
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<{ companyId: string | null; invalid: boolean }> {
  const requested = new URL(request.url).searchParams.get('company_id')
  if (requested) {
    const parsed = CompanyIdSchema.safeParse(requested)
    return { companyId: parsed.success ? parsed.data : null, invalid: !parsed.success }
  }
  return { companyId: await getActiveCompanyId(supabase, userId), invalid: false }
}

function accessErrorCode(reason?: string): string {
  switch (reason) {
    case 'permission_denied': return 'PERMISSION_DENIED'
    case 'company_not_found': return 'INVALID_COMPANY_ID'
    case 'database_error': return 'DATABASE_QUERY_FAILED'
    case 'one_off_expired': return 'ONE_OFF_YEAR_END_NOT_ACTIVE'
    default: return 'YEAR_END_ENTITLEMENT_REQUIRED'
  }
}

function rpcErrorCode(message: string): string {
  const known = [
    'INVALID_COMPANY_ID',
    'PERMISSION_DENIED',
    'ONE_OFF_YEAR_END_NOT_ACTIVE',
    'YEAR_END_ENTITLEMENT_REQUIRED',
    'FISCAL_YEAR_OVERLAP',
    'FISCAL_YEAR_NOT_CONTIGUOUS',
    'PERIOD_CREATE_BLOCKED_BY_OPEN_PERIODS',
    'INVALID_FISCAL_YEAR_RANGE',
  ]
  return known.find((code) => message.includes(code)) ?? 'FISCAL_YEAR_NOT_CREATED'
}

export async function GET(request: Request) {
  const rid = requestId()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED', requestId: rid }, { status: 401 })
  }

  const requested = await resolveRequestedCompanyId(request, supabase, user.id)
  if (requested.invalid) return errorResponseFromCode('INVALID_COMPANY_ID', log, { requestId: rid })
  if (!requested.companyId) return errorResponseFromCode('COMPANY_CONTEXT_MISSING', log, { requestId: rid })

  const db = createServiceClient()
  const access = await resolveFiscalPeriodAccess(db, user.id, requested.companyId)
  if (!access.allowed) {
    return errorResponseFromCode(accessErrorCode(access.reason), log, {
      requestId: rid,
      reason: access.databaseError,
      details: { company_id: requested.companyId },
    })
  }

  let query = db
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', requested.companyId)
    .order('period_start', { ascending: false })

  if (access.allowedPeriodIds !== null) {
    if (access.allowedPeriodIds.length === 0) {
      if (access.accessSource === 'platform_admin') {
        await auditPlatformFiscalPeriodOperation(db, {
          actorUserId: user.id,
          companyId: requested.companyId,
          operation: 'list',
          requestId: rid,
        })
      }
      return NextResponse.json({
        status: 'empty',
        data: [],
        periods: [],
        canCreateFiscalYear: access.canCreateFiscalYear,
        accessSource: access.accessSource,
        requestId: rid,
      })
    }
    query = query.in('id', access.allowedPeriodIds)
  }

  const { data, error } = await query
  if (error) {
    return errorResponseFromCode('DATABASE_QUERY_FAILED', log, {
      requestId: rid,
      reason: error.message,
      details: { operation: 'list_fiscal_periods', company_id: requested.companyId },
    })
  }

  if (access.accessSource === 'platform_admin') {
    try {
      await auditPlatformFiscalPeriodOperation(db, {
        actorUserId: user.id,
        companyId: requested.companyId,
        operation: 'list',
        requestId: rid,
      })
    } catch (error) {
      return errorResponseFromCode('DATABASE_QUERY_FAILED', log, {
        requestId: rid,
        reason: error instanceof Error ? error.message : String(error),
        details: { operation: 'audit_platform_fiscal_period_list' },
      })
    }
  }

  const periods = data ?? []
  return NextResponse.json({
    status: periods.length === 0 ? 'empty' : 'ok',
    data: periods,
    periods,
    canCreateFiscalYear: access.canCreateFiscalYear,
    accessSource: access.accessSource,
    requestId: rid,
  })
}

export async function POST(request: Request) {
  const rid = requestId()
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED', requestId: rid }, { status: 401 })
  }

  const requested = await resolveRequestedCompanyId(request, supabase, user.id)
  if (requested.invalid) return errorResponseFromCode('INVALID_COMPANY_ID', log, { requestId: rid })
  if (!requested.companyId) return errorResponseFromCode('COMPANY_CONTEXT_MISSING', log, { requestId: rid })

  const validation = await validateBody(request, CreateFiscalPeriodSchema)
  if (!validation.success) return validation.response

  const db = createServiceClient()
  const access = await resolveFiscalPeriodAccess(db, user.id, requested.companyId)
  if (!access.allowed) {
    return errorResponseFromCode(accessErrorCode(access.reason), log, {
      requestId: rid,
      reason: access.databaseError,
      details: { company_id: requested.companyId },
    })
  }
  if (!access.canWrite) return errorResponseFromCode('PERMISSION_DENIED', log, { requestId: rid })

  const body = validation.data
  const { data, error } = await db.rpc('create_fiscal_year_atomic_internal', {
    p_company_id: requested.companyId,
    p_actor_user_id: user.id,
    p_name: body.name,
    p_period_start: body.period_start,
    p_period_end: body.period_end,
    p_request_id: rid,
  })

  if (error) {
    const code = rpcErrorCode(error.message)
    return errorResponseFromCode(code, log, {
      requestId: rid,
      reason: error.message,
      details: { company_id: requested.companyId },
    })
  }

  const period = Array.isArray(data) ? data[0] : data
  if (!period) {
    return errorResponseFromCode('FISCAL_YEAR_NOT_CREATED', log, {
      requestId: rid,
      details: { company_id: requested.companyId },
    })
  }

  if (access.accessSource === 'platform_admin') {
    try {
      await auditPlatformFiscalPeriodOperation(db, {
        actorUserId: user.id,
        companyId: requested.companyId,
        fiscalPeriodId: period.id,
        operation: 'create',
        requestId: rid,
      })
    } catch (error) {
      return errorResponseFromCode('DATABASE_QUERY_FAILED', log, {
        requestId: rid,
        reason: error instanceof Error ? error.message : String(error),
        details: { operation: 'audit_platform_fiscal_period_create' },
      })
    }
  }

  return NextResponse.json({ status: 'ok', data: period, requestId: rid }, { status: 201 })
}
