/**
 * ISO 20022 camt.054 (BankToCustomerDebitCreditNotification) XML parser
 *
 * Debit/credit notification — commonly used for Bankgiro inbetalningar
 * (incoming payment notifications with OCR references). Same <Ntry>
 * structure as camt.053 but wrapped in <BkToCstmrDbtCdtNtfctn>/<Ntfctn>.
 * Namespace: urn:iso:std:iso:20022:tech:xsd:camt.054.001.XX
 */

import { createCamtFormat } from './camt-shared'

export const camt054Format = createCamtFormat({
  id: 'camt054',
  name: 'ISO 20022 camt.054',
  description: 'ISO 20022 BankToCustomerDebitCreditNotification — avisering (XML)',
  detectKeywords: ['camt.054', 'bktocstmrdbtcdtntfctn', 'banktocustomerdebitcreditnotification'],
})
