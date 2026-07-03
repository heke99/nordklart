/**
 * ISO 20022 camt.052 (BankToCustomerAccountReport) XML parser
 *
 * Intraday account report — same <Ntry> structure as camt.053 but wrapped in
 * <BkToCstmrAcctRpt>/<Rpt>. Pending (PDNG) entries are skipped with a
 * warning: only booked entries become bokförda affärshändelser.
 * Namespace: urn:iso:std:iso:20022:tech:xsd:camt.052.001.XX
 */

import { createCamtFormat } from './camt-shared'

export const camt052Format = createCamtFormat({
  id: 'camt052',
  name: 'ISO 20022 camt.052',
  description: 'ISO 20022 BankToCustomerAccountReport — intradagsrapport (XML)',
  detectKeywords: ['camt.052', 'bktocstmracctrpt', 'banktocustomeraccountreport'],
})
