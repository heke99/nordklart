import { sruCodeForAccount, type SruEntityType } from '@/lib/reports/sru/account-sru'

/**
 * SRU Code Computation — SRU codes are used for NE (enskild firma) and INK2R
 * (aktiebolag) filed with Skatteverket.
 */

/**
 * Compute the SRU code for a given BAS account number.
 *
 * Delegates to the declaration mapping tables (lib/reports/sru/account-sru):
 * INK2R codes for an aktiebolag, NE codes for an enskild firma. The earlier
 * hand-written ranges here produced codes that do not exist on either form
 * (7203, 7210, 7310–7325 …) and were exported as #SRU records in SIE.
 */
export function computeSRUCode(
  accountNumber: string,
  entityType: SruEntityType = 'aktiebolag',
): string | null {
  return sruCodeForAccount(accountNumber, entityType)
}
