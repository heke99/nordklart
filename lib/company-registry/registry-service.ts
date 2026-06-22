import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanyRegistryLookup } from './provider'

type SnapshotStatus = 'not_requested' | 'verified' | 'not_found' | 'ceased' | 'manual_review'

export type CompanyRegistrySnapshot = {
  id: string
  company_id: string | null
  provider: 'manual' | 'bolagsverket' | 'skatteverket'
  lookup_status: SnapshotStatus
  organization_number: string | null
  normalized_data: Record<string, unknown>
  source_payload: Record<string, unknown>
  retrieved_at: string | null
  user_confirmed_at: string | null
  created_at: string
  updated_at: string
}

export type CompanyRegistryDiff = Array<{
  field: 'company_name' | 'address_line1' | 'postal_code' | 'city'
  labelSv: string
  currentValue: string | null
  registryValue: string | null
}>

function clean(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function lookupStatusFromRegistryStatus(status: CompanyRegistryLookup['registryStatus']): SnapshotStatus {
  if (status === 'active') return 'verified'
  if (status === 'ceased') return 'ceased'
  return 'manual_review'
}

export function normalizedDataFromLookup(company: CompanyRegistryLookup): Record<string, unknown> {
  const sourceNormalized = company.sourcePayload?.normalized
  const normalized = sourceNormalized && typeof sourceNormalized === 'object' && !Array.isArray(sourceNormalized)
    ? sourceNormalized as Record<string, unknown>
    : {}

  return {
    ...normalized,
    organization_number: company.organizationNumber,
    company_name: company.companyName,
    legal_form: company.legalForm,
    registry_status: company.registryStatus,
    address: company.address,
    address_line1: company.address?.street ?? null,
    postal_code: company.address?.postalCode ?? null,
    city: company.address?.city ?? null,
    sni_codes: company.sniCodes,
    retrieved_at: company.retrievedAt,
  }
}

export function publicLookupPayload(company: CompanyRegistryLookup) {
  return {
    organizationNumber: company.organizationNumber,
    companyName: company.companyName,
    legalForm: company.legalForm,
    registryStatus: company.registryStatus,
    address: company.address,
    sniCodes: company.sniCodes,
    retrievedAt: company.retrievedAt,
  }
}

export async function upsertCompanyRegistrySnapshot(
  supabase: SupabaseClient,
  input: {
    companyId?: string | null
    signupDraftId?: string | null
    company: CompanyRegistryLookup
    userConfirmedAt?: string | null
  },
): Promise<CompanyRegistrySnapshot | null> {
  const payload = {
    signup_draft_id: input.signupDraftId ?? null,
    company_id: input.companyId ?? null,
    provider: 'bolagsverket',
    lookup_status: lookupStatusFromRegistryStatus(input.company.registryStatus),
    organization_number: input.company.organizationNumber,
    normalized_data: normalizedDataFromLookup(input.company),
    source_payload: input.company.sourcePayload ?? {},
    retrieved_at: input.company.retrievedAt,
    user_confirmed_at: input.userConfirmedAt ?? null,
  }

  const existingId = input.companyId
    ? await supabase
      .from('company_registry_snapshots')
      .select('id')
      .eq('company_id', input.companyId)
      .eq('provider', 'bolagsverket')
      .maybeSingle()
    : { data: null, error: null }

  const existing = existingId.data as { id: string } | null
  const result = existing?.id
    ? await supabase
      .from('company_registry_snapshots')
      .update(payload)
      .eq('id', existing.id)
      .select('*')
      .single()
    : await supabase
      .from('company_registry_snapshots')
      .insert(payload)
      .select('*')
      .single()

  if (result.error) {
    console.error('[company-registry] snapshot write failed', {
      companyId: input.companyId,
      signupDraftId: input.signupDraftId,
      message: result.error.message,
    })
    return null
  }
  return result.data as CompanyRegistrySnapshot
}

export async function getLatestBolagsverketSnapshot(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanyRegistrySnapshot | null> {
  const { data, error } = await supabase
    .from('company_registry_snapshots')
    .select('*')
    .eq('company_id', companyId)
    .eq('provider', 'bolagsverket')
    .order('retrieved_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[company-registry] snapshot read failed', { companyId, message: error.message })
    return null
  }
  return data as CompanyRegistrySnapshot | null
}

export function diffRegistryAgainstSettings(
  registry: Record<string, unknown>,
  settings: Record<string, unknown> | null | undefined,
): CompanyRegistryDiff {
  const rows: CompanyRegistryDiff = [
    {
      field: 'company_name',
      labelSv: 'Företagsnamn',
      currentValue: clean(settings?.company_name),
      registryValue: clean(registry.company_name),
    },
    {
      field: 'address_line1',
      labelSv: 'Adress',
      currentValue: clean(settings?.address_line1),
      registryValue: clean(registry.address_line1),
    },
    {
      field: 'postal_code',
      labelSv: 'Postnummer',
      currentValue: clean(settings?.postal_code),
      registryValue: clean(registry.postal_code),
    },
    {
      field: 'city',
      labelSv: 'Ort',
      currentValue: clean(settings?.city),
      registryValue: clean(registry.city),
    },
  ]

  return rows.filter((row) => row.registryValue && row.registryValue !== row.currentValue)
}

export function safeSettingsPatchFromRegistry(registry: Record<string, unknown>) {
  return {
    ...(clean(registry.company_name) ? { company_name: clean(registry.company_name) } : {}),
    ...(clean(registry.address_line1) ? { address_line1: clean(registry.address_line1) } : {}),
    ...(clean(registry.postal_code) ? { postal_code: clean(registry.postal_code) } : {}),
    ...(clean(registry.city) ? { city: clean(registry.city) } : {}),
  }
}
