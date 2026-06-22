export type CompanyRegistryLookupStatus =
  | 'idle'
  | 'invalid'
  | 'searching'
  | 'found'
  | 'not_found'
  | 'unavailable'
  | 'error'

export type CompanyRegistryCompany = {
  organizationNumber: string
  companyName: string
  legalForm: string | null
  registryStatus: 'active' | 'ceased' | 'manual_review'
  address: { street: string | null; postalCode: string | null; city: string | null } | null
  sniCodes?: Array<{ code: string; name: string }>
  retrievedAt?: string | null
}

export type CompanyRegistryLookupResponse = {
  available: boolean
  found?: boolean
  status?: string
  message?: string
  company?: CompanyRegistryCompany
  lookupToken?: string
}
