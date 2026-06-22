import 'server-only'

import {
  BolagsverketClientError,
  BolagsverketVardefullaDatamangderClient,
  type BolagsverketApiError,
  type BolagsverketConnectionDiagnostics,
} from './bolagsverket-client'
import { getBolagsverketConfigSummary } from './bolagsverket-config'
import { normalizeBolagsverketOrganization } from './normalize-vardefulla'

export type CompanyRegistryProviderId = 'bolagsverket'

export type CompanyRegistryUnavailableReason =
  | 'not_configured'
  | 'token_failed'
  | 'token_rejected'
  | 'token_missing'
  | 'api_forbidden'
  | 'api_failed'
  | 'network_error'
  | 'unknown_error'

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

export type CompanyRegistryUnavailable = {
  available: false
  reason: CompanyRegistryUnavailableReason
  status?: number | null
  requestId?: string | null
  details?: BolagsverketApiError | string | null
}

export type CompanyRegistryLookupResult =
  | CompanyRegistryUnavailable
  | { available: true; found: false }
  | { available: true; found: true; company: CompanyRegistryLookup }

function unavailableFromError(error: unknown): CompanyRegistryUnavailable {
  if (error instanceof BolagsverketClientError) {
    return {
      available: false,
      reason: (error.code as CompanyRegistryUnavailableReason) ?? 'api_failed',
      status: error.status || null,
      requestId: error.requestId,
      details: error.details,
    }
  }

  return {
    available: false,
    reason: error instanceof Error ? 'network_error' : 'unknown_error',
    status: null,
    requestId: null,
    details: error instanceof Error ? error.message : null,
  }
}

function logBolagsverketError(event: string, client: BolagsverketVardefullaDatamangderClient, error: unknown) {
  if (error instanceof BolagsverketClientError) {
    console.error(event, {
      status: error.status,
      code: error.code,
      requestId: error.requestId,
      environment: client.environment,
      message: error.message,
      details: error.details,
    })
    return
  }

  console.error(event, {
    environment: client.environment,
    message: error instanceof Error ? error.message : 'unknown error',
  })
}

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
  if (!client) return { available: false, reason: 'not_configured' }

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
    if (error instanceof BolagsverketClientError && (error.status === 400 || error.status === 404)) {
      return { available: true, found: false }
    }

    logBolagsverketError('[bolagsverket] lookup failed', client, error)
    return unavailableFromError(error)
  }
}

export async function listAnnualReportsAtBolagsverket(organizationNumber: string) {
  const client = BolagsverketVardefullaDatamangderClient.fromEnv()
  if (!client) return { available: false as const, reason: 'not_configured' as const }

  try {
    const response = await client.listDocuments(organizationNumber)
    return { available: true as const, documents: response.dokument ?? [] }
  } catch (error) {
    if (error instanceof BolagsverketClientError && (error.status === 400 || error.status === 404)) {
      return { available: true as const, documents: [] }
    }
    logBolagsverketError('[bolagsverket] document list failed', client, error)
    return unavailableFromError(error)
  }
}

export async function getAnnualReportZipAtBolagsverket(documentId: string) {
  const client = BolagsverketVardefullaDatamangderClient.fromEnv()
  if (!client) return { available: false as const, reason: 'not_configured' as const }

  try {
    const document = await client.getDocumentZip(documentId)
    return { available: true as const, document }
  } catch (error) {
    if (error instanceof BolagsverketClientError && error.status === 404) {
      return { available: true as const, document: null }
    }
    logBolagsverketError('[bolagsverket] document download failed', client, error)
    return unavailableFromError(error)
  }
}

export async function isBolagsverketRegistryAvailable() {
  const client = BolagsverketVardefullaDatamangderClient.fromEnv()
  if (!client) {
    const { configured: _configured, ...summary } = getBolagsverketConfigSummary()
    return {
      available: false as const,
      configured: false as const,
      ...summary,
    }
  }

  try {
    return { available: await client.isAlive(), configured: true as const, environment: client.environment }
  } catch (error) {
    logBolagsverketError('[bolagsverket] health check failed', client, error)
    return {
      ...unavailableFromError(error),
      configured: true as const,
      environment: client.environment,
    }
  }
}

export async function diagnoseBolagsverketRegistry(): Promise<BolagsverketConnectionDiagnostics> {
  const client = BolagsverketVardefullaDatamangderClient.fromEnv()
  if (!client) {
    return {
      ...getBolagsverketConfigSummary(),
      token: null,
      isAlive: null,
    }
  }

  return client.diagnoseConnection()
}
