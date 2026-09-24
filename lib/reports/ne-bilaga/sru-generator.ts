import type { NEBalanceRutor, NEDeclaration, NEDeclarationRutor, SRUFile, SRURecord } from '@/lib/reports/ne-bilaga/types'
import { NE_SRU_FIELD_CODES } from '@/lib/reports/ne-bilaga/types'
import { getBranding } from '@/lib/branding/service'
import { computePeriodSuffix } from '@/lib/reports/ink2/sru-generator'
import { SKV_FIELD_CODES } from '@/lib/reports/sru/skv-field-codes'

const CRLF = '\r\n'
const PROGRAM_VERSION = '1.0'

function sanitizeString(str: string): string {
  return str.replace(/#/g, '').replace(/[\r\n]/g, ' ').substring(0, 250)
}

/** NE rows in form order: balance sheet B1–B16, then R1–R11. */
const NE_ROW_ORDER: Array<keyof NEBalanceRutor | keyof NEDeclarationRutor> = [
  'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15', 'B16',
  'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11',
]

export interface NESRUSubmission {
  infoSru: string
  blanketterSru: string
  generatedAt: string
}

/**
 * NE is filed under the sole trader's person-/samordningsnummer, which the
 * SRU format wants as 12 digits (ÅÅÅÅMMDDNNNN). A 10-digit number gets its
 * century from the birth year: not in the future → 20xx, otherwise 19xx.
 */
export function neIdentity(value: string | null, today: Date = new Date()): string {
  const clean = (value ?? '').replace(/\D/g, '')
  if (clean.length === 12) return clean
  if (clean.length !== 10) return clean || '000000000000'
  const yy = Number(clean.slice(0, 2))
  const currentYy = today.getFullYear() % 100
  const century = yy <= currentYy ? '20' : '19'
  return `${century}${clean}`
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
  return Math.trunc(amount).toString()
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
  lines.push(`#ORGNR ${neIdentity(declaration.companyInfo.orgNumber)}`)
  lines.push(`#NAMN ${sanitizeString(declaration.companyInfo.companyName)}`)
  lines.push('#MEDIELEV_SLUT')
  return lines.join(CRLF) + CRLF
}

function generateBlanketterSru(declaration: NEDeclaration, now: Date): string {
  const identity = neIdentity(declaration.companyInfo.orgNumber)
  const incomeYear = declaration.fiscalYear.end.substring(0, 4)
  const lines: string[] = []
  lines.push(`#BLANKETT NE-${incomeYear}${computePeriodSuffix(declaration.fiscalYear.end)}`)
  lines.push(`#IDENTITET ${identity} ${formatDate(now)} ${formatTime(now)}`)
  lines.push(`#NAMN ${sanitizeString(declaration.companyInfo.companyName)}`)
  lines.push(`#UPPGIFT 7011 ${dateStringToSRU(declaration.fiscalYear.start)}`)
  lines.push(`#UPPGIFT 7012 ${dateStringToSRU(declaration.fiscalYear.end)}`)

  for (const row of NE_ROW_ORDER) {
    const value = row.startsWith('B')
      ? declaration.balance?.[row as keyof NEBalanceRutor]
      : declaration.rutor[row as keyof NEDeclarationRutor]
    if (typeof value === 'number' && value !== 0) {
      lines.push(`#UPPGIFT ${NE_SRU_FIELD_CODES[row]} ${formatSRUAmount(value)}`)
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
  for (const match of submission.blanketterSru.matchAll(/^#UPPGIFT (\d{4}) /gm)) {
    if (!SKV_FIELD_CODES.NE.has(match[1])) errors.push(`Unknown NE field code ${match[1]}`)
  }
  if (!submission.blanketterSru.includes('#UPPGIFT 7440')) warnings.push('NE saknar R11-resultat (7440) i SRU-utkastet.')
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
