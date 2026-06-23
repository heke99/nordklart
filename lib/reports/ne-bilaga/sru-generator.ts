import type { NEDeclaration, SRUFile, SRURecord } from '@/lib/reports/ne-bilaga/types'
import { getBranding } from '@/lib/branding/service'

const CRLF = '\r\n'
const PROGRAM_VERSION = '1.0'

function sanitizeString(str: string): string {
  return str.replace(/#/g, '').replace(/[\r\n]/g, ' ').substring(0, 250)
}

/**
 * SRU field codes for the currently supported NE base rutor. R12–R48 are
 * deliberately blocked by the NE readiness engine until the EF questionnaire
 * and tax-specific calculations are complete.
 */
const NE_SRU_FIELD_CODES: Record<string, string> = {
  R1: '7310',
  R2: '7311',
  R3: '7312',
  R4: '7313',
  R5: '7320',
  R6: '7321',
  R7: '7322',
  R8: '7323',
  R9: '7324',
  R10: '7325',
  R11: '7350',
}

export interface NESRUSubmission {
  infoSru: string
  blanketterSru: string
  generatedAt: string
}

function cleanIdentity(value: string | null): string {
  const clean = (value ?? '').replace(/\D/g, '')
  return clean || '0000000000'
}

function dateStringToSRU(dateStr: string): string {
  return dateStr.replace(/-/g, '')
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  const s = String(date.getSeconds()).padStart(2, '0')
  return `${h}${m}${s}`
}

function formatSRUAmount(amount: number): string {
  return Math.round(amount).toString()
}

function generateInfoSru(declaration: NEDeclaration, now: Date): string {
  const lines: string[] = []
  lines.push('#DATABESKRIVNING_START')
  lines.push('#PRODUKT SRU')
  lines.push(`#SKAPAD ${formatDate(now)} ${formatTime(now)}`)
  lines.push(`#PROGRAM ${sanitizeString(getBranding().appName.toLowerCase())} ${PROGRAM_VERSION}`)
  lines.push('#FILNAMN BLANKETTER.SRU')
  lines.push('#DATABESKRIVNING_SLUT')
  lines.push('#MEDIELEV_START')
  lines.push(`#ORGNR ${cleanIdentity(declaration.companyInfo.orgNumber)}`)
  lines.push(`#NAMN ${sanitizeString(declaration.companyInfo.companyName)}`)
  lines.push('#MEDIELEV_SLUT')
  return lines.join(CRLF) + CRLF
}

function generateBlanketterSru(declaration: NEDeclaration, now: Date): string {
  const identity = cleanIdentity(declaration.companyInfo.orgNumber)
  const incomeYear = declaration.fiscalYear.end.substring(0, 4)
  const lines: string[] = []
  lines.push(`#BLANKETT NE-${incomeYear}P4`)
  lines.push(`#IDENTITET ${identity} ${formatDate(now)} ${formatTime(now)}`)
  lines.push(`#NAMN ${sanitizeString(declaration.companyInfo.companyName)}`)
  lines.push(`#UPPGIFT 7011 ${dateStringToSRU(declaration.fiscalYear.start)}`)
  lines.push(`#UPPGIFT 7012 ${dateStringToSRU(declaration.fiscalYear.end)}`)

  const rutaEntries = Object.entries(NE_SRU_FIELD_CODES) as [keyof NEDeclaration['rutor'], string][]
  for (const [ruta, fieldCode] of rutaEntries) {
    const value = declaration.rutor[ruta]
    if (typeof value === 'number' && value !== 0) {
      lines.push(`#UPPGIFT ${fieldCode} ${formatSRUAmount(value)}`)
    }
  }

  lines.push('#BLANKETTSLUT')
  lines.push('#FIL_SLUT')
  return lines.join(CRLF) + CRLF
}

export function generateNESRUSubmission(declaration: NEDeclaration): NESRUSubmission {
  const now = new Date()
  return {
    infoSru: generateInfoSru(declaration, now),
    blanketterSru: generateBlanketterSru(declaration, now),
    generatedAt: now.toISOString(),
  }
}

/** Legacy single-file object kept for existing tests/callers. */
export function generateSRUFile(declaration: NEDeclaration): SRUFile {
  const records: SRURecord[] = []
  const submission = generateNESRUSubmission(declaration)
  for (const line of submission.blanketterSru.trim().split(/\r?\n/)) {
    const [fieldCode, ...rest] = line.replace(/^#/, '').split(' ')
    records.push({ fieldCode, value: rest.join(' ') })
  }
  return { records, generatedAt: submission.generatedAt }
}

export function sruFileToString(sruFile: SRUFile): string {
  return sruFile.records
    .map((record) => record.value === '' ? `#${record.fieldCode}` : `#${record.fieldCode} ${record.value}`)
    .join(CRLF) + CRLF
}

export function validateNESRUSubmission(submission: NESRUSubmission): { isValid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!submission.infoSru.includes('#FILNAMN BLANKETTER.SRU')) errors.push('INFO.SRU must reference BLANKETTER.SRU')
  if (!submission.blanketterSru.includes('#BLANKETT NE-')) errors.push('BLANKETTER.SRU missing NE blankett')
  if (!/^#IDENTITET (\d{10}|\d{12}) \d{8} \d{6}\r?$/m.test(submission.blanketterSru)) errors.push('NE blankett missing valid #IDENTITET')
  if (!/^#FIL_SLUT\r?$/m.test(submission.blanketterSru)) errors.push('BLANKETTER.SRU missing #FIL_SLUT')
  if (new TextEncoder().encode(submission.blanketterSru).byteLength > 5 * 1024 * 1024) errors.push('BLANKETTER.SRU överstiger 5 MB.')
  if (!submission.blanketterSru.includes('#UPPGIFT 7350')) warnings.push('NE saknar R11-resultat i SRU-utkastet.')
  return { isValid: errors.length === 0, errors, warnings }
}

export function validateSRUFile(sruFile: SRUFile): { isValid: boolean; errors: string[] } {
  const content = sruFileToString(sruFile)
  const errors: string[] = []
  if (!content.includes('#BLANKETT NE-')) errors.push('Missing NE blankett')
  if (!content.includes('#BLANKETTSLUT')) errors.push('Missing BLANKETTSLUT')
  if (!content.includes('#FIL_SLUT')) errors.push('Missing FIL_SLUT')
  return { isValid: errors.length === 0, errors }
}

export function getSRUFilename(declaration: NEDeclaration): string {
  const year = declaration.fiscalYear.start.substring(0, 4)
  const orgNumber = declaration.companyInfo.orgNumber?.replace(/-/g, '') || 'unknown'
  return `NE_SRU_${orgNumber}_${year}.zip`
}
