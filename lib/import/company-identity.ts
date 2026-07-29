export const SIE_COMPANY_IDENTITY_STATUSES = [
  'match',
  'missing_in_sie',
  'missing_in_company',
  'mismatch',
] as const

export type SIECompanyIdentityStatus =
  (typeof SIE_COMPANY_IDENTITY_STATUSES)[number]

export interface SIECompanyIdentityResult {
  status: SIECompanyIdentityStatus
  sieOrganisationNumber: string | null
  companyOrganisationNumber: string | null
  normalizedSieOrganisationNumber: string | null
  normalizedCompanyOrganisationNumber: string | null
  nameChanged: boolean
  message: string
}

/**
 * Normalize a Swedish organisation number to ten digits.
 *
 * The country prefix, separators and whitespace are presentation details.
 * Twelve-digit values beginning with 16 are the tax/VAT representation of a
 * ten-digit organisation number and are reduced to the legal identifier.
 */
export function normalizeSwedishOrganisationNumber(
  value: string | null | undefined,
): string | null {
  const digits = value?.replace(/\D/g, '') ?? ''
  if (!digits) return null
  if (digits.length === 12 && digits.startsWith('16')) return digits.slice(2)
  return digits.length === 10 ? digits : null
}

function normalizedName(value: string | null | undefined): string | null {
  const normalized = value
    ?.normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('sv-SE')
  return normalized || null
}

export function compareSIECompanyIdentity(input: {
  sieOrganisationNumber: string | null | undefined
  companyOrganisationNumber: string | null | undefined
  sieCompanyName?: string | null
  companyName?: string | null
}): SIECompanyIdentityResult {
  const normalizedSie = normalizeSwedishOrganisationNumber(
    input.sieOrganisationNumber,
  )
  const normalizedCompany = normalizeSwedishOrganisationNumber(
    input.companyOrganisationNumber,
  )
  const nameChanged =
    normalizedSie !== null
    && normalizedCompany !== null
    && normalizedSie === normalizedCompany
    && normalizedName(input.sieCompanyName) !== null
    && normalizedName(input.companyName) !== null
    && normalizedName(input.sieCompanyName) !== normalizedName(input.companyName)

  if (!normalizedSie) {
    return {
      status: 'missing_in_sie',
      sieOrganisationNumber: input.sieOrganisationNumber ?? null,
      companyOrganisationNumber: input.companyOrganisationNumber ?? null,
      normalizedSieOrganisationNumber: null,
      normalizedCompanyOrganisationNumber: normalizedCompany,
      nameChanged: false,
      message:
        'SIE-filen saknar ett giltigt organisationsnummer. Kontrollera företaget uttryckligen innan importen genomförs.',
    }
  }

  if (!normalizedCompany) {
    return {
      status: 'missing_in_company',
      sieOrganisationNumber: input.sieOrganisationNumber ?? null,
      companyOrganisationNumber: input.companyOrganisationNumber ?? null,
      normalizedSieOrganisationNumber: normalizedSie,
      normalizedCompanyOrganisationNumber: null,
      nameChanged: false,
      message:
        'Det valda Nordklart-företaget saknar ett giltigt organisationsnummer. Komplettera företagsprofilen innan importen genomförs.',
    }
  }

  if (normalizedSie !== normalizedCompany) {
    return {
      status: 'mismatch',
      sieOrganisationNumber: input.sieOrganisationNumber ?? null,
      companyOrganisationNumber: input.companyOrganisationNumber ?? null,
      normalizedSieOrganisationNumber: normalizedSie,
      normalizedCompanyOrganisationNumber: normalizedCompany,
      nameChanged: false,
      message:
        'SIE-filen tillhör ett annat organisationsnummer än det valda Nordklart-företaget.',
    }
  }

  return {
    status: 'match',
    sieOrganisationNumber: input.sieOrganisationNumber ?? null,
    companyOrganisationNumber: input.companyOrganisationNumber ?? null,
    normalizedSieOrganisationNumber: normalizedSie,
    normalizedCompanyOrganisationNumber: normalizedCompany,
    nameChanged,
    message: nameChanged
      ? 'Organisationsnumret stämmer. Företagsnamnet skiljer sig, vilket kan bero på ett namnbyte.'
      : 'Organisationsnumret stämmer med det valda Nordklart-företaget.',
  }
}
