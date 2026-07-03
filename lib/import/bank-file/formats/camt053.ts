/**
 * ISO 20022 camt.053 (BankToCustomerStatement) XML parser
 *
 * This is the EU standard for bank statements, increasingly used by Swedish banks.
 * Namespace: urn:iso:std:iso:20022:tech:xsd:camt.053.001.XX (various versions)
 *
 * Entry parsing is shared with camt.052/054 — see camt-shared.ts.
 */

import { createCamtFormat } from './camt-shared'

export const camt053Format = createCamtFormat({
  id: 'camt053',
  name: 'ISO 20022 camt.053',
  description: 'ISO 20022 BankToCustomerStatement (XML)',
  detectKeywords: ['camt.053', 'bktocstmrstmt', 'banktocustomerstatement'],
})
