import type { NEAccountMapping, NEBalanceRutor } from './types'

/**
 * NE-bilaga (enskild näringsidkare) — räkenskapsschema R1–R11 and B1–B16.
 *
 * Source: BAS kopplingstabell "NE – Inkomst av näringsverksamhet, Enskilda
 * näringsidkare som inte upprättar ett förenklat årsbokslut"
 * (NE_EJ_K1-Intervall-231002, bas.se/kontoplaner/sru), field codes per
 * Skatteverket NE_SKV2161-13-02-25-02 (2025P4).
 *
 * The table lists some groups on two rows with "(+)" and "(−)": the account
 * goes to the income row when its balance is income and to the cost row when
 * it is a cost. Rules are evaluated in order; the first that matches both the
 * range and the sign condition wins.
 *
 * R1 vs R2 follows the VAT return (Skatteverket: "hur försäljningen redovisas
 * i momsdeklarationen avgör"). Export and EU sales are momspliktig omsättning
 * (R1). R2 is momsfri verksamhet: BAS 3004 (momsfri försäljning), rent that is
 * not voluntarily taxable (3911/3912), and — for a business that is not
 * registered for VAT at all — every revenue account.
 */
export const NE_ACCOUNT_MAPPINGS: NEAccountMapping[] = [
  // Nedskrivningar and 79xx before the depreciation rows.
  { ruta: 'R8', description: 'Nedskrivningar omsättningstillgångar, övriga rörelsekostnader', isExpense: true,
    accountRanges: [{ start: '7740', end: '7749' }, { start: '7790', end: '7799' }, { start: '7900', end: '7999' }] },
  { ruta: 'R9', description: 'Av- och nedskrivningar byggnader och markanläggningar', isExpense: true,
    accountRanges: [
      { start: '7720', end: '7729' }, { start: '7770', end: '7779' },
      { start: '7820', end: '7829' }, { start: '7840', end: '7849' },
    ] },
  { ruta: 'R10', description: 'Av- och nedskrivningar maskiner, inventarier och immateriella tillgångar', isExpense: true,
    accountRanges: [
      { start: '7700', end: '7719' }, { start: '7730', end: '7739' }, { start: '7750', end: '7769' },
      { start: '7780', end: '7789' }, { start: '7800', end: '7819' }, { start: '7830', end: '7839' },
      { start: '7850', end: '7899' }, { start: '8850', end: '8859' },
    ] },
  { ruta: 'R4', description: 'Aktiverat arbete, ränte- och finansiella intäkter', isExpense: false, when: 'any',
    accountRanges: [
      { start: '3800', end: '3899' },
      { start: '8010', end: '8019' }, { start: '8110', end: '8119' }, { start: '8200', end: '8219' },
      { start: '8250', end: '8269' }, { start: '8300', end: '8319' }, { start: '8340', end: '8349' },
      { start: '8360', end: '8369' }, { start: '8390', end: '8399' }, { start: '8440', end: '8449' },
      { start: '8880', end: '8889' },
    ] },
  { ruta: 'R8', description: 'Räntekostnader och finansiella kostnader', isExpense: true, when: 'any',
    accountRanges: [
      { start: '8070', end: '8089' }, { start: '8170', end: '8189' }, { start: '8270', end: '8289' },
      { start: '8370', end: '8389' }, { start: '8400', end: '8429' }, { start: '8460', end: '8469' },
      { start: '8480', end: '8489' },
    ] },
  // Sign-dependent rows: (+) → R4, (−) → R8.
  { ruta: 'R4', description: 'Finansiella poster (om intäkt)', isExpense: false, when: 'income',
    accountRanges: [
      { start: '8000', end: '8099' }, { start: '8100', end: '8199' }, { start: '8200', end: '8299' },
      { start: '8300', end: '8399' }, { start: '8400', end: '8499' }, { start: '8810', end: '8819' },
      { start: '8860', end: '8869' },
    ] },
  { ruta: 'R8', description: 'Finansiella poster (om kostnad)', isExpense: true, when: 'expense',
    accountRanges: [
      { start: '8000', end: '8099' }, { start: '8100', end: '8199' }, { start: '8200', end: '8299' },
      { start: '8300', end: '8399' }, { start: '8400', end: '8499' }, { start: '8810', end: '8819' },
      { start: '8860', end: '8869' },
    ] },
  { ruta: 'R5', description: 'Varor, material och tjänster', isExpense: true,
    accountRanges: [{ start: '4000', end: '4999' }] },
  { ruta: 'R6', description: 'Övriga externa kostnader', isExpense: true,
    accountRanges: [{ start: '5000', end: '6999' }] },
  { ruta: 'R7', description: 'Anställd personal', isExpense: true,
    accountRanges: [{ start: '7000', end: '7699' }] },
  { ruta: 'R2', description: 'Momsfria intäkter', isExpense: false,
    accountRanges: [{ start: '3004', end: '3004' }, { start: '3911', end: '3912' }] },
  { ruta: 'R1', description: 'Försäljning och övriga momspliktiga intäkter', isExpense: false,
    accountRanges: [{ start: '3000', end: '3799' }, { start: '3900', end: '3999' }] },
]

type BalanceRow = keyof NEBalanceRutor

/** B-rows per the BAS NE table. B10 is computed (tillgångar − skulder). */
export const NE_BALANCE_MAPPINGS: Array<{ row: BalanceRow; asset: boolean; ranges: Array<[string, string]> }> = [
  { row: 'B1', asset: true, ranges: [['1000', '1099']] },
  { row: 'B3', asset: true, ranges: [['1130', '1149'], ['1180', '1189'], ['1291', '1291']] },
  { row: 'B2', asset: true, ranges: [['1100', '1129'], ['1150', '1179'], ['1190', '1199']] },
  { row: 'B4', asset: true, ranges: [['1200', '1290'], ['1292', '1299']] },
  { row: 'B5', asset: true, ranges: [['1300', '1399']] },
  { row: 'B6', asset: true, ranges: [['1400', '1499']] },
  { row: 'B7', asset: true, ranges: [['1500', '1599']] },
  { row: 'B8', asset: true, ranges: [['1600', '1899']] },
  { row: 'B9', asset: true, ranges: [['1900', '1999']] },
  { row: 'B11', asset: false, ranges: [['2100', '2199']] },
  { row: 'B12', asset: false, ranges: [['2200', '2299']] },
  { row: 'B13', asset: false, ranges: [['2300', '2399'], ['2410', '2419'], ['2480', '2489']] },
  { row: 'B15', asset: false, ranges: [['2440', '2449'], ['2460', '2479']] },
  // The table lists nothing for B14 (a sole trader's tax is private) and no
  // row for 25xx; a balance there is still a liability of the business, so it
  // is reported with övriga skulder and flagged for review.
  { row: 'B16', asset: false, ranges: [['2420', '2439'], ['2450', '2459'], ['2490', '2499'], ['2500', '2999']] },
]

function inRanges(account: string, ranges: NEAccountMapping['accountRanges']): boolean {
  return ranges.some((r) => account >= r.start && account <= r.end && !(r.exclude ?? []).includes(account))
}

/** First mapping that matches the account and its sign; exported for tests. */
export function findNEMapping(accountNumber: string, balance: number, momsfriVerksamhet = false): NEAccountMapping | null {
  const income = balance < 0
  for (const mapping of NE_ACCOUNT_MAPPINGS) {
    if (!inRanges(accountNumber, mapping.accountRanges)) continue
    if (mapping.when === 'income' && !income) continue
    if (mapping.when === 'expense' && income) continue
    if (momsfriVerksamhet && mapping.ruta === 'R1') {
      return NE_ACCOUNT_MAPPINGS.find((m) => m.ruta === 'R2') ?? mapping
    }
    return mapping
  }
  return null
}

