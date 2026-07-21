import { NextResponse } from 'next/server'
import { saveMappings } from '@/lib/import/sie-import'
import type { AccountMapping } from '@/lib/import/types'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

export const GET = withRouteContext(
  'sie_import.mappings.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx
    const { data, error } = await supabase
      .from('sie_account_mappings')
      .select('*')
      .eq('company_id', companyId)
      .order('source_account')
    if (error) return errorResponseFromCode('DATABASE_QUERY_FAILED', log, { requestId, reason: error.message })
    return NextResponse.json({ data: data ?? [] })
  },
  { accessPolicy: 'sie_import' },
)

export const POST = withRouteContext(
  'sie_import.mappings.save',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx
    const body = await request.json()
    const mappings: AccountMapping[] = body.mappings
    if (!Array.isArray(mappings)) {
      return errorResponseFromCode('VALIDATION_FAILED', log, { requestId, details: { reason: 'Ogiltiga kontomappningar.' } })
    }
    try {
      await saveMappings(supabase, companyId, mappings)
      return NextResponse.json({ success: true })
    } catch (error) {
      return errorResponseFromCode('DATABASE_QUERY_FAILED', log, {
        requestId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  },
  { requireWrite: true, accessPolicy: 'sie_import' },
)

export const PUT = withRouteContext(
  'sie_import.mappings.update',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx
    const body = await request.json()
    const sourceAccount = typeof body.sourceAccount === 'string' ? body.sourceAccount.trim() : ''
    const targetAccount = typeof body.targetAccount === 'string' ? body.targetAccount.trim() : ''
    if (!sourceAccount || !/^\d{4}$/.test(targetAccount)) {
      return errorResponseFromCode('VALIDATION_FAILED', log, { requestId, details: { reason: 'Källkonto och fyrsiffrigt målkonto krävs.' } })
    }
    const { data, error } = await supabase
      .from('sie_account_mappings')
      .upsert({
        user_id: user.id,
        company_id: companyId,
        source_account: sourceAccount,
        target_account: targetAccount,
        confidence: 1,
        match_type: 'manual',
      }, { onConflict: 'company_id,source_account' })
      .select()
      .single()
    if (error) return errorResponseFromCode('DATABASE_QUERY_FAILED', log, { requestId, reason: error.message })
    return NextResponse.json({ data })
  },
  { requireWrite: true, accessPolicy: 'sie_import' },
)

export const DELETE = withRouteContext(
  'sie_import.mappings.delete',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx
    const sourceAccount = new URL(request.url).searchParams.get('sourceAccount')
    let query = supabase.from('sie_account_mappings').delete().eq('company_id', companyId)
    if (sourceAccount) query = query.eq('source_account', sourceAccount)
    const { error } = await query
    if (error) return errorResponseFromCode('DATABASE_QUERY_FAILED', log, { requestId, reason: error.message })
    return NextResponse.json({ success: true })
  },
  { requireWrite: true, accessPolicy: 'sie_import' },
)
