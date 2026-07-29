import { describe, expect, it } from 'vitest'
import {
  compareSIECompanyIdentity,
  normalizeSwedishOrganisationNumber,
} from '../company-identity'

describe('normalizeSwedishOrganisationNumber', () => {
  it.each([
    ['556016-0680', '5560160680'],
    ['556016 0680', '5560160680'],
    ['SE16556016068001', null],
    ['165560160680', '5560160680'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeSwedishOrganisationNumber(input)).toBe(expected)
  })
})

describe('compareSIECompanyIdentity', () => {
  it('matches presentation variants', () => {
    expect(
      compareSIECompanyIdentity({
        sieOrganisationNumber: '556016-0680',
        companyOrganisationNumber: '165560160680',
      }).status,
    ).toBe('match')
  })

  it('blocks different legal identities', () => {
    expect(
      compareSIECompanyIdentity({
        sieOrganisationNumber: '556016-0680',
        companyOrganisationNumber: '556677-8899',
      }).status,
    ).toBe('mismatch')
  })

  it('reports either missing side explicitly', () => {
    expect(
      compareSIECompanyIdentity({
        sieOrganisationNumber: null,
        companyOrganisationNumber: '556016-0680',
      }).status,
    ).toBe('missing_in_sie')
    expect(
      compareSIECompanyIdentity({
        sieOrganisationNumber: '556016-0680',
        companyOrganisationNumber: null,
      }).status,
    ).toBe('missing_in_company')
  })

  it('allows a company name change for the same organisation number', () => {
    const result = compareSIECompanyIdentity({
      sieOrganisationNumber: '556016-0680',
      companyOrganisationNumber: '5560160680',
      sieCompanyName: 'Gamla Namnet AB',
      companyName: 'Nya Namnet AB',
    })
    expect(result.status).toBe('match')
    expect(result.nameChanged).toBe(true)
  })
})
