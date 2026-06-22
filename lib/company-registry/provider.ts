import 'server-only'

import { BolagsverketClientError, BolagsverketVardefullaDatamangderClient } from './bolagsverket-client'
import { normalizeBolagsverketOrganization } from './normalize-vardefulla'

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
 * Production-safe Bolagsverket Värdefulla datamängder boundary.
 *
 * - Missing env credentials keep the provider unavailable, so signup falls
 *   back to manual entry instead of calling guessed endpoints.
 * - Live API errors are logged without secrets and converted to unavailable
 *   for public signup, preserving signup availability.
 * - Exact identifier equality is enforced by the public route after this
 *   function returns.
 */
export async function lookupCompanyAtBolagsverket(
  organizationNumber: string,
): Promise<CompanyRegistryLookupResult> {
  const client = BolagsverketVardefullaDatamangderClient.fromEnv()
  if (!client) return { available: false }

  try {
    const response = await client.lookupOrganization(organizationNumber)
    const organizations = response.organisationer ?? []
    if (organizations.length === 0) return { available: true, found: false }

    const normalized = organizations
      .map((organization) => normalizeBolagsverketOrganization(organization))
      .filter((company): company is CompanyRegistryLookup => Boolean(company))
      .find((company) => company.organizationNumber === organizationNumber)

    if (!normalized) return { available: true, found: false }
    return { available: true, found: true, company: normalized }
  } catch (error) {
    if (error instanceof BolagsverketClientError) {
      if (error.status === 400 || error.status === 404) return { available: true, found: false }
      console.error('[bolagsverket] lookup failed', {
        status: error.status,
        requestId: error.requestId,
        environment: client.environment,
        message: error.message,
      })
      return { available: false }
    }

    console.error('[bolagsverket] unexpected lookup failure', {
      environment: client.environment,
      message: error instanceof Error ? error.message : 'unknown error',
    })
    return { available: false }
  }
}

export async function listAnnualReportsAtBolagsverket(organizationNumber: string) {
  const client = BolagsverketVardefullaDatamangderClient.fromEnv()
  if (!client) return { available: false as const }

  try {
    const response = await client.listDocuments(organizationNumber)
    return { available: true as const, documents: response.dokument ?? [] }
  } catch (error) {
    if (error instanceof BolagsverketClientError && (error.status === 400 || error.status === 404)) {
      return { available: true as const, documents: [] }
    }
    console.error('[bolagsverket] document list failed', {
      environment: client.environment,
      message: error instanceof Error ? error.message : 'unknown error',
    })
    return { available: false as const }
  }
}


export async function getAnnualReportZipAtBolagsverket(documentId: string) {
  const client = BolagsverketVardefullaDatamangderClient.fromEnv()
  if (!client) return { available: false as const }

  try {
    const document = await client.getDocumentZip(documentId)
    return { available: true as const, document }
  } catch (error) {
    if (error instanceof BolagsverketClientError && error.status === 404) {
      return { available: true as const, document: null }
    }
    console.error('[bolagsverket] document download failed', {
      environment: client.environment,
      message: error instanceof Error ? error.message : 'unknown error',
    })
    return { available: false as const }
  }
}

export async function isBolagsverketRegistryAvailable() {
  const client = BolagsverketVardefullaDatamangderClient.fromEnv()
  if (!client) return { available: false as const, configured: false as const }

  try {
    return { available: await client.isAlive(), configured: true as const, environment: client.environment }
  } catch (error) {
    console.error('[bolagsverket] health check failed', {
      environment: client.environment,
      message: error instanceof Error ? error.message : 'unknown error',
    })
    return { available: false as const, configured: true as const, environment: client.environment }
  }
}
