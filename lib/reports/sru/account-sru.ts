import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from '@/lib/reports/ink2/account-mappings'
import { NE_ACCOUNT_MAPPINGS, NE_BALANCE_MAPPINGS } from '@/lib/reports/ne-bilaga/account-mappings'
import { NE_SRU_FIELD_CODES } from '@/lib/reports/ne-bilaga/types'
import { SKV_FIELD_CODES } from './skv-field-codes'

export type SruEntityType = 'aktiebolag' | 'enskild_firma'

/**
 * The SRU field code a BAS account reports to: INK2R for an aktiebolag, NE for
 * an enskild firma. Derived from the same mapping tables the declaration
 * engines use, so the chart of accounts, SIE #SRU records and the declaration
 * never disagree.
 *
 * Where the form splits a group by sign ("Om netto +/−"), the income-side
 * code is returned — that is what the account reports to in the normal case,
 * and SIE carries a single code per account. Equity in an enskild firma maps
 * to B10 (eget kapital).
 */
export function sruCodeForAccount(accountNumber: string, entityType: SruEntityType = 'aktiebolag'): string | null {
  if (!/^\d{4}$/.test(accountNumber)) return null

  if (entityType === 'enskild_firma') {
    if (accountNumber >= '2000' && accountNumber <= '2099') return NE_SRU_FIELD_CODES.B10
    const balance = NE_BALANCE_MAPPINGS.find((m) => m.ranges.some(([a, b]) => accountNumber >= a && accountNumber <= b))
    if (balance) return NE_SRU_FIELD_CODES[balance.row]
    const income = accountNumber.charAt(0) === '3' || accountNumber.charAt(0) === '8'
    const rule = NE_ACCOUNT_MAPPINGS.find(
      (m) =>
        m.accountRanges.some((r) => accountNumber >= r.start && accountNumber <= r.end) &&
        (m.when === undefined || m.when === 'any' || (m.when === 'income') === income),
    )
    return rule ? NE_SRU_FIELD_CODES[rule.ruta] : null
  }

  const mapping = INK2R_ACCOUNT_MAPPINGS.find((m) => isAccountInMapping(accountNumber, m))
  return mapping?.sruCode ?? null
}

/** True when `code` is an official field on the form this entity type files. */
export function isValidSruCode(code: string | null | undefined, entityType: SruEntityType = 'aktiebolag'): boolean {
  if (!code) return false
  return (entityType === 'enskild_firma' ? SKV_FIELD_CODES.NE : SKV_FIELD_CODES.INK2R).has(code)
}
