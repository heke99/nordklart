/**
 * EU member states reference data.
 *
 * Used by core VAT logic and export extensions for:
 * - Filtering EU vs non-EU customers
 * - VIES VAT number validation (country prefix)
 * - Intrastat partner country lookup
 * - EC Sales List country grouping
 */

export interface EUCountry {
  code: string       // ISO 3166-1 alpha-2
  name: string       // Swedish name
  nameEn: string     // English name
  vatPrefix: string  // VIES VAT number prefix
  currency: string   // Primary currency
}

/**
 * All 27 EU member states (as of 2025).
 * Sweden (SE) is included but should be filtered out for intra-community checks.
 */
export const EU_COUNTRIES: EUCountry[] = [
  { code: 'AT', name: 'Österrike', nameEn: 'Austria', vatPrefix: 'AT', currency: 'EUR' },
  { code: 'BE', name: 'Belgien', nameEn: 'Belgium', vatPrefix: 'BE', currency: 'EUR' },
  { code: 'BG', name: 'Bulgarien', nameEn: 'Bulgaria', vatPrefix: 'BG', currency: 'BGN' },
  { code: 'HR', name: 'Kroatien', nameEn: 'Croatia', vatPrefix: 'HR', currency: 'EUR' },
  { code: 'CY', name: 'Cypern', nameEn: 'Cyprus', vatPrefix: 'CY', currency: 'EUR' },
  { code: 'CZ', name: 'Tjeckien', nameEn: 'Czech Republic', vatPrefix: 'CZ', currency: 'CZK' },
  { code: 'DK', name: 'Danmark', nameEn: 'Denmark', vatPrefix: 'DK', currency: 'DKK' },
  { code: 'EE', name: 'Estland', nameEn: 'Estonia', vatPrefix: 'EE', currency: 'EUR' },
  { code: 'FI', name: 'Finland', nameEn: 'Finland', vatPrefix: 'FI', currency: 'EUR' },
  { code: 'FR', name: 'Frankrike', nameEn: 'France', vatPrefix: 'FR', currency: 'EUR' },
  { code: 'DE', name: 'Tyskland', nameEn: 'Germany', vatPrefix: 'DE', currency: 'EUR' },
  { code: 'GR', name: 'Grekland', nameEn: 'Greece', vatPrefix: 'EL', currency: 'EUR' },
  { code: 'HU', name: 'Ungern', nameEn: 'Hungary', vatPrefix: 'HU', currency: 'HUF' },
  { code: 'IE', name: 'Irland', nameEn: 'Ireland', vatPrefix: 'IE', currency: 'EUR' },
  { code: 'IT', name: 'Italien', nameEn: 'Italy', vatPrefix: 'IT', currency: 'EUR' },
  { code: 'LV', name: 'Lettland', nameEn: 'Latvia', vatPrefix: 'LV', currency: 'EUR' },
  { code: 'LT', name: 'Litauen', nameEn: 'Lithuania', vatPrefix: 'LT', currency: 'EUR' },
  { code: 'LU', name: 'Luxemburg', nameEn: 'Luxembourg', vatPrefix: 'LU', currency: 'EUR' },
  { code: 'MT', name: 'Malta', nameEn: 'Malta', vatPrefix: 'MT', currency: 'EUR' },
  { code: 'NL', name: 'Nederländerna', nameEn: 'Netherlands', vatPrefix: 'NL', currency: 'EUR' },
  { code: 'PL', name: 'Polen', nameEn: 'Poland', vatPrefix: 'PL', currency: 'PLN' },
  { code: 'PT', name: 'Portugal', nameEn: 'Portugal', vatPrefix: 'PT', currency: 'EUR' },
  { code: 'RO', name: 'Rumänien', nameEn: 'Romania', vatPrefix: 'RO', currency: 'RON' },
  { code: 'SK', name: 'Slovakien', nameEn: 'Slovakia', vatPrefix: 'SK', currency: 'EUR' },
  { code: 'SI', name: 'Slovenien', nameEn: 'Slovenia', vatPrefix: 'SI', currency: 'EUR' },
  { code: 'ES', name: 'Spanien', nameEn: 'Spain', vatPrefix: 'ES', currency: 'EUR' },
  { code: 'SE', name: 'Sverige', nameEn: 'Sweden', vatPrefix: 'SE', currency: 'SEK' },
]

/** EU country codes excluding Sweden (for intra-community checks) */
export const EU_COUNTRY_CODES_EXCL_SE = EU_COUNTRIES
  .filter(c => c.code !== 'SE')
  .map(c => c.code)

/** All EU country codes including Sweden */
export const EU_COUNTRY_CODES = EU_COUNTRIES.map(c => c.code)

/**
 * Build a lookup set of all known names/codes for EU countries (excluding Sweden).
 * Handles ISO codes, English names, and Swedish names — all uppercased for matching.
 */
const EU_LOOKUP_EXCL_SE = new Set(
  EU_COUNTRIES
    .filter(c => c.code !== 'SE')
    .flatMap(c => [c.code, c.name, c.nameEn].map(s => s.toUpperCase()))
)

const EU_LOOKUP_INCL_SE = new Set(
  EU_COUNTRIES
    .flatMap(c => [c.code, c.name, c.nameEn].map(s => s.toUpperCase()))
)

/**
 * Check if a country value is an EU member state (excluding Sweden).
 * Accepts ISO codes ("DE"), English names ("Germany"), or Swedish names ("Tyskland").
 */
export function isEUCountry(country: string): boolean {
  return EU_LOOKUP_EXCL_SE.has(country.trim().toUpperCase())
}

/**
 * Check if a country value is an EU member state (including Sweden).
 * Accepts ISO codes, English names, or Swedish names.
 */
export function isEUCountryIncludingSE(country: string): boolean {
  return EU_LOOKUP_INCL_SE.has(country.trim().toUpperCase())
}

/** Get EU country data by ISO code, English name, or Swedish name */
export function getEUCountry(country: string): EUCountry | undefined {
  const upper = country.trim().toUpperCase()
  return EU_COUNTRIES.find(
    c => c.code === upper || c.name.toUpperCase() === upper || c.nameEn.toUpperCase() === upper
  )
}

/** Get the VIES VAT prefix for a country (note: Greece uses 'EL' not 'GR') */
export function getVatPrefix(countryCode: string): string | undefined {
  return getEUCountry(countryCode)?.vatPrefix
}

/**
 * Normalize a country value to its ISO 3166-1 alpha-2 code.
 * Accepts ISO codes, English names, or Swedish names.
 * Returns the input uppercased if no match is found.
 */
export function toCountryCode(country: string): string {
  const found = getEUCountry(country)
  return found ? found.code : country.trim().toUpperCase()
}
