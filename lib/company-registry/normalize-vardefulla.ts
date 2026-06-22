import 'server-only'

import { mapEntityType } from '@/lib/company-lookup/entity-type-map'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import type { CompanyRegistryLookup } from './provider'
import type { BolagsverketOrganization } from './bolagsverket-client'

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function primaryName(organization: BolagsverketOrganization): string | null {
  const names = organization.organisationsnamn?.organisationsnamnLista ?? []
  return clean(names.find((item) => item.organisationsnamntyp?.kod === 'FORETAGSNAMN')?.namn)
    ?? clean(names[0]?.namn)
}

function registryStatus(organization: BolagsverketOrganization): CompanyRegistryLookup['registryStatus'] {
  if (organization.avregistreradOrganisation?.avregistreringsdatum) return 'ceased'
  const activeCode = organization.verksamOrganisation?.kod
  if (activeCode === 'NEJ') return 'manual_review'
  const procedures = organization.pagaendeAvvecklingsEllerOmstruktureringsforfarande?.pagaendeAvvecklingsEllerOmstruktureringsforfarandeLista ?? []
  if (procedures.length > 0) return 'manual_review'
  return 'active'
}

function sourceErrors(organization: BolagsverketOrganization): Array<{ field: string; type: string | null; description: string | null }> {
  const fields: Array<[string, { fel?: { typ?: string | null; felBeskrivning?: string | null } | null } | null | undefined]> = [
    ['organisationsnamn', organization.organisationsnamn],
    ['organisationsform', organization.organisationsform],
    ['juridiskForm', organization.juridiskForm],
    ['verksamOrganisation', organization.verksamOrganisation],
    ['organisationsdatum', organization.organisationsdatum],
    ['verksamhetsbeskrivning', organization.verksamhetsbeskrivning],
    ['naringsgrenOrganisation', organization.naringsgrenOrganisation],
    ['postadressOrganisation', organization.postadressOrganisation],
    ['avregistreradOrganisation', organization.avregistreradOrganisation],
    ['avregistreringsorsak', organization.avregistreringsorsak],
    ['pagaendeAvvecklingsEllerOmstruktureringsforfarande', organization.pagaendeAvvecklingsEllerOmstruktureringsforfarande],
  ]
  return fields
    .filter(([, value]) => value?.fel)
    .map(([field, value]) => ({
      field,
      type: value?.fel?.typ ?? null,
      description: value?.fel?.felBeskrivning ?? null,
    }))
}

export function normalizeBolagsverketOrganization(organization: BolagsverketOrganization): CompanyRegistryLookup | null {
  const rawIdentity = clean(organization.organisationsidentitet?.identitetsbeteckning)
  const organizationNumber = normalizeOrgNumber(rawIdentity)
  if (!organizationNumber) return null

  const orgFormCode = clean(organization.organisationsform?.kod)
  const orgFormText = clean(organization.organisationsform?.klartext)
  const legalForm = mapEntityType(orgFormCode) ?? mapEntityType(orgFormText) ?? orgFormCode ?? orgFormText
  const address = organization.postadressOrganisation?.postadress
  const sniCodes = (organization.naringsgrenOrganisation?.sni ?? [])
    .map((item) => ({ code: clean(item.kod), name: clean(item.klartext) }))
    .filter((item): item is { code: string; name: string } => Boolean(item.code && item.name))

  const errors = sourceErrors(organization)
  const status = errors.some((error) => error.type === 'ORGANISATION_FINNS_EJ')
    ? 'ceased'
    : errors.length > 0
      ? 'manual_review'
      : registryStatus(organization)

  return {
    organizationNumber,
    companyName: primaryName(organization) ?? organizationNumber,
    legalForm,
    registryStatus: status,
    address: address
      ? {
          street: clean(address.utdelningsadress),
          postalCode: clean(address.postnummer),
          city: clean(address.postort),
        }
      : null,
    sniCodes,
    sourcePayload: {
      provider: 'bolagsverket_vardefulla_datamangder',
      raw: organization as unknown as Record<string, unknown>,
      normalized: {
        organization_number: organizationNumber,
        legal_form: legalForm,
        organization_form_code: orgFormCode,
        organization_form_text: orgFormText,
        juridical_form_code: clean(organization.juridiskForm?.kod),
        juridical_form_text: clean(organization.juridiskForm?.klartext),
        registration_date: clean(organization.organisationsdatum?.registreringsdatum),
        scb_imported_at: clean(organization.organisationsdatum?.infortHosScb),
        business_description: clean(organization.verksamhetsbeskrivning?.beskrivning),
        deregistered_at: clean(organization.avregistreradOrganisation?.avregistreringsdatum),
        deregistration_reason_code: clean(organization.avregistreringsorsak?.kod),
        deregistration_reason_text: clean(organization.avregistreringsorsak?.klartext),
        active_code: clean(organization.verksamOrganisation?.kod),
        source_errors: errors,
      },
    },
    retrievedAt: new Date().toISOString(),
  }
}
