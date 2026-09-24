// NE-blankett (SKV 2161) räkenskapsschema, resultaträkning R1–R11.
// Field codes and BAS ranges: see lib/reports/ne-bilaga/ne-engine.ts.
export interface NEDeclarationRutor {
  R1: number   // Försäljning och utfört arbete samt övriga momspliktiga intäkter (7400)
  R2: number   // Momsfria intäkter (7401)
  R3: number   // Bil- och bostadsförmån m.m. (7402)
  R4: number   // Ränteintäkter m.m. (7403)
  R5: number   // Varor, material och tjänster (7500)
  R6: number   // Övriga externa kostnader (7501)
  R7: number   // Anställd personal (7502)
  R8: number   // Räntekostnader m.m. (7503)
  R9: number   // Av- och nedskrivningar byggnader och markanläggningar (7504)
  R10: number  // Av- och nedskrivningar maskiner, inventarier och immateriella (7505)
  R11: number  // Bokfört resultat (7440)
}

// NE-blankett balansräkning B1–B16.
export interface NEBalanceRutor {
  B1: number   // Immateriella anläggningstillgångar (7200)
  B2: number   // Byggnader och markanläggningar (7210)
  B3: number   // Mark och andra tillgångar som inte får skrivas av (7211)
  B4: number   // Maskiner och inventarier (7212)
  B5: number   // Övriga anläggningstillgångar (7213)
  B6: number   // Varulager (7240)
  B7: number   // Kundfordringar (7250)
  B8: number   // Övriga fordringar (7260)
  B9: number   // Kassa och bank (7280)
  B10: number  // Eget kapital (tillgångar − skulder) (7300)
  B11: number  // Obeskattade reserver (7320)
  B12: number  // Avsättningar (7330)
  B13: number  // Låneskulder (7380)
  B14: number  // Skatteskulder (7381)
  B15: number  // Leverantörsskulder (7382)
  B16: number  // Övriga skulder (7383)
}

/** Skatteverket SRU field code per NE row (NE_SKV2161-13-02-25-02, 2025P4). */
export const NE_SRU_FIELD_CODES: Record<keyof NEDeclarationRutor | keyof NEBalanceRutor, string> = {
  B1: '7200', B2: '7210', B3: '7211', B4: '7212', B5: '7213', B6: '7240', B7: '7250', B8: '7260',
  B9: '7280', B10: '7300', B11: '7320', B12: '7330', B13: '7380', B14: '7381', B15: '7382', B16: '7383',
  R1: '7400', R2: '7401', R3: '7402', R4: '7403', R5: '7500', R6: '7501', R7: '7502', R8: '7503',
  R9: '7504', R10: '7505', R11: '7440',
}

/** Which way an account's balance must lean for a rule to apply. */
export type NESignCondition = 'any' | 'income' | 'expense'

// NE account mapping configuration
export interface NEAccountMapping {
  ruta: keyof NEDeclarationRutor
  description: string
  accountRanges: Array<{
    start: string
    end: string
    exclude?: string[]
  }>
  isExpense: boolean  // true = cost row (debit positive), false = income row (credit positive)
  /** BAS table "(+)"/"(−)": only when the account's net is income/cost. */
  when?: NESignCondition
}

// NE declaration response
export interface NEDeclaration {
  fiscalYear: {
    id: string
    name: string
    start: string
    end: string
    isClosed: boolean
  }
  rutor: NEDeclarationRutor
  balance: NEBalanceRutor
  // Detailed breakdown per ruta
  breakdown: Record<keyof NEDeclarationRutor, {
    accounts: Array<{
      accountNumber: string
      accountName: string
      amount: number
    }>
    total: number
  }>
  // Company info for SRU
  companyInfo: {
    companyName: string
    orgNumber: string | null
  }
  // Warnings
  warnings: string[]
  taxAnalysis?: {
    readinessScore: number
    status: 'draft' | 'needs_input' | 'needs_review' | 'blocked' | 'ready_to_export'
    blockerCount: number
    issues: Array<{ code: string; severity: 'ok' | 'warning' | 'blocker'; message: string; source?: string }>
  }
}

// SRU file format types
export interface SRURecord {
  fieldCode: string
  value: string | number
}

export interface SRUFile {
  records: SRURecord[]
  generatedAt: string
}

// Labels for NE rutor
export const NE_RUTA_LABELS: Record<keyof NEDeclarationRutor, string> = {
  R1: 'Försäljning och utfört arbete samt övriga momspliktiga intäkter',
  R2: 'Momsfria intäkter',
  R3: 'Bil- och bostadsförmån m.m.',
  R4: 'Ränteintäkter m.m.',
  R5: 'Varor, material och tjänster',
  R6: 'Övriga externa kostnader',
  R7: 'Anställd personal',
  R8: 'Räntekostnader m.m.',
  R9: 'Av- och nedskrivningar byggnader och markanläggningar',
  R10: 'Av- och nedskrivningar maskiner, inventarier och immateriella tillgångar',
  R11: 'Bokfört resultat'
}

export const NE_BALANCE_LABELS: Record<keyof NEBalanceRutor, string> = {
  B1: 'Immateriella anläggningstillgångar',
  B2: 'Byggnader och markanläggningar',
  B3: 'Mark och andra tillgångar som inte får skrivas av',
  B4: 'Maskiner och inventarier',
  B5: 'Övriga anläggningstillgångar',
  B6: 'Varulager',
  B7: 'Kundfordringar',
  B8: 'Övriga fordringar',
  B9: 'Kassa och bank',
  B10: 'Eget kapital',
  B11: 'Obeskattade reserver',
  B12: 'Avsättningar',
  B13: 'Låneskulder',
  B14: 'Skatteskulder',
  B15: 'Leverantörsskulder',
  B16: 'Övriga skulder',
}
