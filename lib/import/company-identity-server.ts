import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  compareSIECompanyIdentity,
  type SIECompanyIdentityResult,
} from './company-identity'

export interface ResolvedCompanyLegalIdentity {
  companyName: string | null
  organisationNumber: string | null
}

export async function loadCompanyLegalIdentity(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ResolvedCompanyLegalIdentity> {
  const [companyResult, settingsResult] = await Promise.all([
    supabase
      .from('companies')
      .select('name,org_number')
      .eq('id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('company_name,org_number')
      .eq('company_id', companyId)
      .maybeSingle(),
  ])

  if (companyResult.error || !companyResult.data) {
    throw new Error(
      `Det valda företaget kunde inte läsas: ${companyResult.error?.message ?? 'saknas'}`,
    )
  }
  if (settingsResult.error) {
    throw new Error(
      `Företagsprofilen kunde inte läsas: ${settingsResult.error.message}`,
    )
  }

  return {
    companyName:
      companyResult.data.name
      ?? settingsResult.data?.company_name
      ?? null,
    organisationNumber:
      companyResult.data.org_number
      ?? settingsResult.data?.org_number
      ?? null,
  }
}

export async function verifySIECompanyIdentity(
  supabase: SupabaseClient,
  companyId: string,
  sie: {
    organisationNumber: string | null | undefined
    companyName?: string | null
  },
): Promise<{
  company: ResolvedCompanyLegalIdentity
  identity: SIECompanyIdentityResult
}> {
  const company = await loadCompanyLegalIdentity(supabase, companyId)
  return {
    company,
    identity: compareSIECompanyIdentity({
      sieOrganisationNumber: sie.organisationNumber,
      companyOrganisationNumber: company.organisationNumber,
      sieCompanyName: sie.companyName,
      companyName: company.companyName,
    }),
  }
}
