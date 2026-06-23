import { getBranding } from '@/lib/branding/service'
import type {
  INK2Declaration,
  INK2RSRUCode,
  SRUSubmission,
} from './types'
import {
  INK2R_ASSET_CODES,
  INK2R_EQUITY_LIABILITY_CODES,
  INK2R_INCOME_CODES,
  INK2S_NUMERIC_CODES,
} from './types'

/**
 * SRU File Generator for INK2 (Aktiebolag)
 *
 * Generates a Skatteverket-compliant SRU submission consisting of:
 *   - INFO.SRU: submitter metadata
 *   - BLANKETTER.SRU: three blankett blocks (INK2, INK2R, INK2S)
 *
 * Encoding: ISO 8859-1 (handled by the API route when writing the response)
 * Line endings: CRLF
 * Amounts: integers in hela kronor, no decimals, no thousands separators
 * Org number: 12 digits with century prefix 16 for juridisk person
 */

const CRLF = '\r\n'
const PROGRAM_VERSION = '1.0'

/**
 * Compute the period suffix for blankett type strings.
 * Based on which month the fiscal year ENDS in:
 *   P1 = Jan-Apr, P2 = May-Aug, P3 = special, P4 = Sep-Dec
 */
function computePeriodSuffix(fiscalYearEnd: string): string {
  const endMonth = parseInt(fiscalYearEnd.substring(5, 7), 10)
  if (endMonth >= 1 && endMonth <= 4) return 'P1'
  if (endMonth >= 5 && endMonth <= 8) return 'P2'
  // P4 covers Sep-Dec (most common: calendar year companies)
  // NOTE: P3 (first/short fiscal year) cannot be derived from end month alone.
  // Callers must handle P3 manually for brutet räkenskapsår.
  return 'P4'
}

/**
 * Get the income year from the fiscal year end date.
 * The year in the blankett type string is the income year.
 */
function getIncomeYear(fiscalYearEnd: string): string {
  return fiscalYearEnd.substring(0, 4)
}

/**
 * Format org number as 12-digit with century prefix.
 * Swedish juridiska personer use century prefix "16".
 * Input: "556677-8899" or "5566778899"
 * Output: "165566778899"
 */
function formatOrgNumber12(orgNumber: string): string {
  const clean = orgNumber.replace(/-/g, '')
  if (clean.length === 12) return clean
  if (clean.length === 10) return `16${clean}`
  return `16${clean}`
}

/**
 * Format a Date as YYYYMMDD
 */
function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/**
 * Format a Date as HHMMSS
 */
function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}${m}${s}`
}

/**
 * Format integer amount for SRU. No decimals, no thousands separator.
 * Truncated to hela kronor by the engine.
 */
function formatAmount(amount: number): string {
  return Math.trunc(amount).toString()
}

/**
 * Generate the INFO.SRU file content
 */
function generateInfoSru(declaration: INK2Declaration, now: Date): string {
  const lines: string[] = []
  const orgNumber12 = declaration.companyInfo.orgNumber
    ? formatOrgNumber12(declaration.companyInfo.orgNumber)
    : '000000000000'

  // DATABESKRIVNING block (required order)
  lines.push('#DATABESKRIVNING_START')
  lines.push('#PRODUKT SRU')
  lines.push(`#SKAPAD ${formatDate(now)} ${formatTime(now)}`)
  lines.push(`#PROGRAM ${sanitizeString(getBranding().appName.toLowerCase())} ${PROGRAM_VERSION}`)
  lines.push('#FILNAMN BLANKETTER.SRU')
  lines.push('#DATABESKRIVNING_SLUT')

  // MEDIELEV block
  lines.push('#MEDIELEV_START')
  lines.push(`#ORGNR ${orgNumber12}`)
  lines.push(`#NAMN ${sanitizeString(declaration.companyInfo.companyName)}`)

  if (declaration.companyInfo.addressLine1) {
    lines.push(`#ADRESS ${sanitizeString(declaration.companyInfo.addressLine1)}`)
  }
  lines.push(`#POSTNR ${declaration.companyInfo.postalCode || '00000'}`)
  lines.push(`#POSTORT ${sanitizeString(declaration.companyInfo.city || 'Okänd')}`)

  if (declaration.companyInfo.email) {
    lines.push(`#EMAIL ${declaration.companyInfo.email}`)
  }

  lines.push('#MEDIELEV_SLUT')

  return lines.join(CRLF) + CRLF
}

/**
 * Generate the BLANKETTER.SRU file content with three blankett blocks
 */
function generateBlanketterSru(declaration: INK2Declaration, now: Date): string {
  const lines: string[] = []
  const orgNumber12 = declaration.companyInfo.orgNumber
    ? formatOrgNumber12(declaration.companyInfo.orgNumber)
    : '000000000000'

  const incomeYear = getIncomeYear(declaration.fiscalYear.end)
  const periodSuffix = computePeriodSuffix(declaration.fiscalYear.end)
  const companyName = sanitizeString(declaration.companyInfo.companyName)
  const dateStr = formatDate(now)

  // Each blankett gets a unique timestamp (increment seconds)
  const time0 = formatTime(now)
  const time1 = formatTime(new Date(now.getTime() + 1000))
  const time2 = formatTime(new Date(now.getTime() + 2000))

  // ---- Block 1: INK2 (huvudblankett) ----
  lines.push(`#BLANKETT INK2-${incomeYear}${periodSuffix}`)
  lines.push(`#IDENTITET ${orgNumber12} ${dateStr} ${time0}`)
  lines.push(`#NAMN ${companyName}`)

  // Fiscal year dates
  lines.push(`#UPPGIFT 7011 ${declaration.ink2['7011']}`)
  lines.push(`#UPPGIFT 7012 ${declaration.ink2['7012']}`)

  // Överskott/underskott
  if (declaration.ink2['7113'] > 0) {
    lines.push(`#UPPGIFT 7113 ${formatAmount(declaration.ink2['7113'])}`)
  }
  if (declaration.ink2['7114'] > 0) {
    lines.push(`#UPPGIFT 7114 ${formatAmount(declaration.ink2['7114'])}`)
  }

  lines.push('#BLANKETTSLUT')

  // ---- Block 2: INK2R (räkenskapsschema) ----
  lines.push(`#BLANKETT INK2R-${incomeYear}${periodSuffix}`)
  lines.push(`#IDENTITET ${orgNumber12} ${dateStr} ${time1}`)
  lines.push(`#NAMN ${companyName}`)

  // Fiscal year dates
  lines.push(`#UPPGIFT 7011 ${declaration.ink2['7011']}`)
  lines.push(`#UPPGIFT 7012 ${declaration.ink2['7012']}`)

  // All INK2R fields in canonical Skatteverket order — emit non-zero values only
  const ink2rCodes: INK2RSRUCode[] = [
    ...INK2R_ASSET_CODES,
    ...INK2R_EQUITY_LIABILITY_CODES,
    ...INK2R_INCOME_CODES,
  ]
  for (const code of ink2rCodes) {
    const value = declaration.ink2r[code]
    if (value !== 0) {
      lines.push(`#UPPGIFT ${code} ${formatAmount(value)}`)
    }
  }

  lines.push('#BLANKETTSLUT')

  // ---- Block 3: INK2S (skattemässiga justeringar) ----
  lines.push(`#BLANKETT INK2S-${incomeYear}${periodSuffix}`)
  lines.push(`#IDENTITET ${orgNumber12} ${dateStr} ${time2}`)
  lines.push(`#NAMN ${companyName}`)

  // Fiscal year dates
  lines.push(`#UPPGIFT 7011 ${declaration.ink2s['7011']}`)
  lines.push(`#UPPGIFT 7012 ${declaration.ink2s['7012']}`)

  // INK2S numeric fields — emit non-zero values only
  for (const code of INK2S_NUMERIC_CODES) {
    const value = declaration.ink2s[code]
    if (typeof value === 'number' && value !== 0) {
      lines.push(`#UPPGIFT ${code} ${formatAmount(value)}`)
    }
  }

  lines.push('#BLANKETTSLUT')

  // Required terminator
  lines.push('#FIL_SLUT')

  return lines.join(CRLF) + CRLF
}

/**
 * Sanitize string for SRU: remove # characters (reserved), limit to 250 chars
 */
function sanitizeString(str: string): string {
  return str.replace(/#/g, '').replace(/[\r\n]/g, ' ').substring(0, 250)
}

/**
 * Generate complete SRU submission (INFO.SRU + BLANKETTER.SRU)
 */
export function generateSRUSubmission(declaration: INK2Declaration): SRUSubmission {
  const now = new Date()

  return {
    infoSru: generateInfoSru(declaration, now),
    blanketterSru: generateBlanketterSru(declaration, now),
    generatedAt: now.toISOString(),
  }
}

/**
 * Validate the generated BLANKETTER.SRU content
 */
export function validateBlanketterSru(content: string): {
  isValid: boolean
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []

  const byteLength = new TextEncoder().encode(content).byteLength
  if (byteLength > 5 * 1024 * 1024) {
    errors.push('BLANKETTER.SRU överstiger Skatteverkets gräns 5 MB.')
  }

  if (!content.endsWith(CRLF)) errors.push('BLANKETTER.SRU måste avslutas med CRLF.')
  if (!/^#FIL_SLUT\r?$/m.test(content)) errors.push('Missing #FIL_SLUT terminator')
  if ((content.match(/^#FIL_SLUT/gm) || []).length !== 1) errors.push('BLANKETTER.SRU ska innehålla exakt en #FIL_SLUT.')

  const requiredBlocks = ['INK2', 'INK2R', 'INK2S']
  for (const block of requiredBlocks) {
    if (!new RegExp(`^#BLANKETT ${block}-`, 'm').test(content)) {
      errors.push(`Missing ${block} blankett block`)
    }
  }

  const blankettslutCount = (content.match(/^#BLANKETTSLUT/gm) || []).length
  if (blankettslutCount !== 3) {
    errors.push(`Expected 3 BLANKETTSLUT, found ${blankettslutCount}`)
  }

  const validFieldCodes = new Set<string>([
    '7011', '7012', '7113', '7114',
    ...INK2R_ASSET_CODES,
    ...INK2R_EQUITY_LIABILITY_CODES,
    ...INK2R_INCOME_CODES,
    ...INK2S_NUMERIC_CODES,
  ])

  const identityRegex = /^#IDENTITET (\d{10}|\d{12}) \d{8} \d{6}\r?$/m
  const blankettBlocks = content.split(/^#BLANKETT /m).slice(1)
  for (const block of blankettBlocks) {
    const type = block.split('\n')[0]?.split('\r')[0] || 'unknown'
    if (!identityRegex.test(block)) errors.push(`Blankett ${type} missing or malformed #IDENTITET`)
    if (!/^#NAMN .+/m.test(block)) errors.push(`Blankett ${type} missing #NAMN`)
    if (!/^#BLANKETTSLUT\r?$/m.test(block)) errors.push(`Blankett ${type} missing #BLANKETTSLUT`)

    const seen = new Set<string>()
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('#UPPGIFT ')) continue
      const match = line.match(/^#UPPGIFT\s+(\d{4})\s+(.+)$/)
      if (!match) {
        errors.push(`Malformed #UPPGIFT in ${type}: ${line}`)
        continue
      }
      const [, code, value] = match
      if (!validFieldCodes.has(code)) errors.push(`Unknown SRU field code ${code} in ${type}`)
      if (seen.has(code)) errors.push(`Duplicate SRU field code ${code} in ${type}`)
      seen.add(code)
      if (!/^701[12]$/.test(code) && !/^-?\d+$/.test(value.trim())) {
        errors.push(`Field ${code} in ${type} must be an integer amount.`)
      }
    }

    if (!seen.has('7011')) errors.push(`Blankett ${type} missing fiscal year start 7011`)
    if (!seen.has('7012')) errors.push(`Blankett ${type} missing fiscal year end 7012`)
  }

  if (!/#UPPGIFT\s+7113\s+\d+/.test(content) && !/#UPPGIFT\s+7114\s+\d+/.test(content)) {
    warnings.push('INK2 saknar både överskott 7113 och underskott 7114. Kontrollera nollresultat eller ofullständig INK2S.')
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  }
}

export function validateSRUSubmission(submission: SRUSubmission): {
  isValid: boolean
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []

  if (!submission.infoSru.includes('#DATABESKRIVNING_START')) errors.push('INFO.SRU missing #DATABESKRIVNING_START')
  if (!submission.infoSru.includes('#FILNAMN BLANKETTER.SRU')) errors.push('INFO.SRU must reference BLANKETTER.SRU')
  if (!submission.infoSru.includes('#MEDIELEV_START')) errors.push('INFO.SRU missing #MEDIELEV_START')
  if (!submission.infoSru.endsWith(CRLF)) errors.push('INFO.SRU must end with CRLF')

  const blanketter = validateBlanketterSru(submission.blanketterSru)
  errors.push(...blanketter.errors)
  warnings.push(...blanketter.warnings)

  return { isValid: errors.length === 0, errors, warnings }
}

/**
 * Get ZIP filename for download
 */
export function getZipFilename(declaration: INK2Declaration): string {
  const year = declaration.fiscalYear.start.substring(0, 4)
  const orgNumber = declaration.companyInfo.orgNumber?.replace(/-/g, '') || 'unknown'
  return `INK2_SRU_${orgNumber}_${year}.zip`
}
