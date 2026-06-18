import 'server-only'

export type CompanyRegistryProviderId = 'bolagsverket'

export type CompanyRegistryLookup = {
  organizationNumber: string
  companyName: string
  legalForm: string | null
  registryStatus: 'active' | 'ceased' | 'manual_review'
  address: {
    street: string | null
    postalCode: string | null
    city: string | null
  } | null
  sniCodes: Array<{ code: string; name: string }>
  sourcePayload: Record<string, unknown>
  retrievedAt: string
}

export type CompanyRegistryLookupResult =
  | { available: false }
  | { available: true; found: false }
  | { available: true; found: true; company: CompanyRegistryLookup }

/**
 * A deliberately disabled boundary for Bolagsverket until Nordklart receives
 * the actual environment-specific endpoint and authentication material. The
 * signup UI and persistence model are ready now, but no guessed endpoint,
 * credential scheme or third-party fallback is allowed into production.
 */
export async function lookupCompanyAtBolagsverket(
  _organizationNumber: string,
): Promise<CompanyRegistryLookupResult> {
  return { available: false }
}
