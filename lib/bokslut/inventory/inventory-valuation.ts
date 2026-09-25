import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput } from '@/types'

/**
 * Lagerinventering vid bokslut — värdering och lagerförändring.
 *
 * Valuation (inkomstskattelagen 17 kap., verified against the statute text):
 *  - 3 §: a lagertillgång may not be taken up below the lower of
 *    anskaffningsvärde and nettoförsäljningsvärde (lägsta värdets princip);
 *    the goods left at year end are deemed to be the last acquired (FIFO).
 *  - 4 §: alternatively the inventory may be taken up at no less than 97 % of
 *    the total anskaffningsvärde (not for property, securities, elcertifikat
 *    or emission rights).
 *  - 4 a §: an enskild näringsidkare with a förenklat årsbokslut need not
 *    value an inventory of at most half a prisbasbelopp (not handled here —
 *    such a firm simply records no adjustment).
 *
 * Booking (BAS): the balance-sheet inventory account is adjusted to the
 * counted value at the balance date against its change account in class 4,
 * e.g. an increase of lager av handelsvaror is Dr 1460 / Cr 4960, a decrease
 * Dr 4960 / Cr 1460. The change account follows the inventory type.
 */

export const INVENTORY_CHANGE_ACCOUNTS: Record<string, { changeAccount: string; label: string }> = {
  '1410': { changeAccount: '4910', label: 'Lager av råvaror' },
  '1440': { changeAccount: '4940', label: 'Produkter i arbete' },
  '1450': { changeAccount: '4950', label: 'Lager av färdiga varor' },
  '1460': { changeAccount: '4960', label: 'Lager av handelsvaror' },
  '1465': { changeAccount: '4960', label: 'Lager av varor VMB' },
  '1470': { changeAccount: '4970', label: 'Pågående arbeten' },
}

export type InventoryValuationMethod = 'lowest_value' | 'alternative_97'

export const ALTERNATIVE_RULE_SHARE = 0.97

export interface InventoryCount {
  /** Inventory account, e.g. '1460'. */
  account: string
  /** Total anskaffningsvärde of the goods on hand (FIFO). */
  cost: number
  /** Nettoförsäljningsvärde, when it is below cost for some goods. */
  netRealizableValue?: number | null
  method: InventoryValuationMethod
}

export interface InventoryValuation {
  account: string
  changeAccount: string
  value: number
  /** Lowest value the tax rules allow for this inventory. */
  taxFloor: number
}

export class InventoryValuationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InventoryValuationError'
  }
}

/** Value one inventory account at the balance date. */
export function valueInventory(count: InventoryCount): InventoryValuation {
  const mapping = INVENTORY_CHANGE_ACCOUNTS[count.account]
  if (!mapping) throw new InventoryValuationError(`Konto ${count.account} är inte ett lagerkonto som stöds.`)
  if (!(count.cost >= 0)) throw new InventoryValuationError('Anskaffningsvärdet måste vara noll eller större.')
  if (count.netRealizableValue != null && !(count.netRealizableValue >= 0)) {
    throw new InventoryValuationError('Nettoförsäljningsvärdet måste vara noll eller större.')
  }
  const cost = roundOre(count.cost)
  const lowest = roundOre(count.netRealizableValue != null ? Math.min(cost, count.netRealizableValue) : cost)
  const alternative = roundOre(cost * ALTERNATIVE_RULE_SHARE)
  const value = count.method === 'alternative_97' ? alternative : lowest
  return {
    account: count.account,
    changeAccount: mapping.changeAccount,
    value,
    taxFloor: Math.min(lowest, alternative),
  }
}

/**
 * Lines that bring `account` from its booked balance (debit-positive) to
 * `value`. Empty when nothing changes.
 */
export function planInventoryAdjustment(
  valuation: InventoryValuation,
  bookedBalance: number,
): CreateJournalEntryLineInput[] {
  const diff = roundOre(valuation.value - roundOre(bookedBalance))
  if (diff === 0) return []
  const amount = Math.abs(diff)
  const description = diff > 0 ? 'Lagerökning enligt inventering' : 'Lagerminskning enligt inventering'
  return diff > 0
    ? [
        { account_number: valuation.account, debit_amount: amount, credit_amount: 0, line_description: description },
        { account_number: valuation.changeAccount, debit_amount: 0, credit_amount: amount, line_description: description },
      ]
    : [
        { account_number: valuation.changeAccount, debit_amount: amount, credit_amount: 0, line_description: description },
        { account_number: valuation.account, debit_amount: 0, credit_amount: amount, line_description: description },
      ]
}
