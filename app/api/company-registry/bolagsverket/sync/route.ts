import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { getActiveCompanyId } from '@/lib/company/context'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { createServiceClient } from '@/lib/supabase/server'
import { lookupCompanyAtBolagsverket } from '@/lib/company-registry/provider'
import {
  diffRegistryAgainstSettings,
  normalizedDataFromLookup,
  safeSettingsPatchFromRegistry,
  upsertCompanyRegistrySnapshot,
} from '@/lib/company-registry/registry-service'

const bodySchema = z.object({
  applySafeFields: z.boolean().optional().default(false),
})

type SyncStatus = 'success' | 'failed' | 'unavailable' | 'not_found'

async function logSyncEvent(
  service: ReturnType<typeof createServiceClient>,
  input: {
    companyId: string
    userId: string
    organizationNumber?: string | null
    status: SyncStatus
    diff?: unknown[]
    appliedSafeFields: boolean
    errorMessage?: string | null
  },
) {
  const { error } = await service.from('company_registry_sync_events').insert({
    company_id: input.companyId,
    provider: 'bolagsverket',
    status: input.status,
    requested_by_user_id: input.userId,
    organization_number: input.organizationNumber ?? null,
    diff: input.diff ?? [],
    applied_safe_fields: input.appliedSafeFields,
    error_message: input.errorMessage ?? null,
  })

  if (error) {
    console.error('[company-registry] failed to write Bolagsverket sync event', {
      companyId: input.companyId,
      status: input.status,
      message: error.message,
    })
  }
}

export async function POST(request: Request) {
  const { user, supabase, error: authError } = await requireAuth()
  if (authError) return authError

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) return NextResponse.json({ error: 'Inget aktivt företag.' }, { status: 403 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: 'Ogiltig begäran.' }, { status: 400 })

  const service = createServiceClient()
  const { data: company } = await service
    .from('companies')
    .select('id, name, org_number')
    .eq('id', companyId)
    .maybeSingle()

  const { data: settings } = await service
    .from('company_settings')
    .select('company_name, org_number, address_line1, postal_code, city')
    .eq('company_id', companyId)
    .maybeSingle()

  const settingsRow = settings as Record<string, unknown> | null
  const companyRow = company as Record<string, unknown> | null
  const rawOrgNumber = (settingsRow?.org_number as string | undefined)
    || (companyRow?.org_number as string | undefined)
    || ''
  const organizationNumber = normalizeOrgNumber(rawOrgNumber)

  if (!organizationNumber) {
    await logSyncEvent(service, {
      companyId,
      userId: user.id,
      status: 'failed',
      appliedSafeFields: parsed.data.applySafeFields,
      errorMessage: 'Företaget saknar giltigt organisationsnummer.',
    })
    return NextResponse.json({ error: 'Företaget saknar giltigt organisationsnummer.', code: 'invalid_organization_number' }, { status: 400 })
  }

  const result = await lookupCompanyAtBolagsverket(organizationNumber)
  if (!result.available) {
    const errorMessage = `Bolagsverket kunde inte nås just nu. Orsak: ${result.reason}${result.status ? ` (${result.status})` : ''}`
    await logSyncEvent(service, {
      companyId,
      userId: user.id,
      organizationNumber,
      status: 'unavailable',
      appliedSafeFields: parsed.data.applySafeFields,
      errorMessage,
    })
    return NextResponse.json({
      error: 'Bolagsverket kunde inte nås just nu.',
      code: result.reason,
      status: result.status ?? null,
      requestId: result.requestId ?? null,
    }, { status: 503 })
  }

  if (!result.found || result.company.organizationNumber !== organizationNumber) {
    await logSyncEvent(service, {
      companyId,
      userId: user.id,
      organizationNumber,
      status: 'not_found',
      appliedSafeFields: parsed.data.applySafeFields,
      errorMessage: 'Företaget hittades inte hos Bolagsverket.',
    })
    return NextResponse.json({ error: 'Företaget hittades inte hos Bolagsverket.', code: 'not_found' }, { status: 404 })
  }

  const snapshot = await upsertCompanyRegistrySnapshot(service, {
    companyId,
    company: result.company,
  })
  const normalized = normalizedDataFromLookup(result.company)
  const diff = diffRegistryAgainstSettings(normalized, settings as Record<string, unknown> | null)

  let updatedSettings: Record<string, unknown> | null = null
  if (parsed.data.applySafeFields) {
    const patch = safeSettingsPatchFromRegistry(normalized)
    if (Object.keys(patch).length > 0) {
      const { data, error } = await service
        .from('company_settings')
        .update(patch)
        .eq('company_id', companyId)
        .select('*')
        .maybeSingle()
      if (error) {
        console.error('[company-registry] settings update from Bolagsverket failed', { companyId, message: error.message })
        await logSyncEvent(service, {
          companyId,
          userId: user.id,
          organizationNumber,
          status: 'failed',
          diff,
          appliedSafeFields: parsed.data.applySafeFields,
          errorMessage: error.message,
        })
        return NextResponse.json({ error: 'Uppgifterna hämtades men kunde inte uppdateras i företagsinställningar.', code: 'settings_update_failed' }, { status: 500 })
      }
      updatedSettings = data as Record<string, unknown> | null
    }
  }

  await logSyncEvent(service, {
    companyId,
    userId: user.id,
    organizationNumber,
    status: 'success',
    diff,
    appliedSafeFields: parsed.data.applySafeFields,
  })

  return NextResponse.json({ snapshot, normalized, diff, updatedSettings })
}
