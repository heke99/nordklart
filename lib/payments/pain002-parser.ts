/**
 * ISO 20022 pain.002 (CustomerPaymentStatusReport) parser.
 *
 * pain.002 is the bank's status answer to a pain.001 payment initiation:
 * per-group, per-payment-info and per-transaction statuses. Swedish banks
 * (SEB, Handelsbanken, Swedbank, Nordea) deliver it via the corporate portal
 * or file gateway after a pain.001 upload.
 *
 * Status codes (ISO 20022 ExternalPaymentTransactionStatus):
 *   ACCP  AcceptedCustomerProfile      → accepted
 *   ACSC  AcceptedSettlementCompleted  → settled
 *   ACSP  AcceptedSettlementInProcess  → accepted
 *   ACTC  AcceptedTechnicalValidation  → accepted
 *   ACWC  AcceptedWithChange           → accepted
 *   PDNG  Pending                      → pending
 *   RJCT  Rejected                     → rejected
 *   PART  PartiallyAccepted            → partially_accepted
 *
 * The parser maps the report onto the payment_initiations model:
 * `original_message_id` ties back to the pain.001 <MsgId> we generated, and
 * each transaction status carries the <OrgnlEndToEndId> we assigned.
 */

import { extractElements, extractTextContent, extractNestedText } from '@/lib/import/bank-file/formats/camt-shared'

export type Pain002GroupStatus =
  | 'accepted'
  | 'settled'
  | 'pending'
  | 'rejected'
  | 'partially_accepted'
  | 'unknown'

export interface Pain002TransactionStatus {
  originalEndToEndId: string | null
  status: Pain002GroupStatus
  rawStatus: string | null
  /** ISO reason code (e.g. AC01 wrong account, AM04 insufficient funds). */
  reasonCode: string | null
  /** Free-text reason from <AddtlInf>. */
  reasonText: string | null
}

export interface Pain002ParseResult {
  /** <OrgnlMsgId> — the pain.001 MsgId this report answers. */
  originalMessageId: string | null
  /** Group-level status (<GrpSts>), fallback to payment-info status. */
  groupStatus: Pain002GroupStatus
  rawGroupStatus: string | null
  transactions: Pain002TransactionStatus[]
  issues: string[]
}

const STATUS_MAP: Record<string, Pain002GroupStatus> = {
  ACCP: 'accepted',
  ACSC: 'settled',
  ACSP: 'accepted',
  ACTC: 'accepted',
  ACWC: 'accepted',
  PDNG: 'pending',
  RJCT: 'rejected',
  PART: 'partially_accepted',
}

function mapStatus(raw: string | null): Pain002GroupStatus {
  if (!raw) return 'unknown'
  return STATUS_MAP[raw.toUpperCase()] ?? 'unknown'
}

/** Quick sniff: is this XML a pain.002 payment status report? */
export function isPain002(content: string): boolean {
  const lower = content.toLowerCase()
  return lower.includes('pain.002') || lower.includes('cstmrpmtstsrpt')
}

export function parsePain002(content: string): Pain002ParseResult {
  const issues: string[] = []

  if (!isPain002(content)) {
    issues.push('Filen ser inte ut som en pain.002-statusrapport (CstmrPmtStsRpt saknas).')
  }

  // <OrgnlGrpInfAndSts><OrgnlMsgId>…</OrgnlMsgId><GrpSts>…</GrpSts></OrgnlGrpInfAndSts>
  const originalMessageId =
    extractNestedText(content, 'OrgnlGrpInfAndSts', 'OrgnlMsgId') ||
    extractTextContent(content, 'OrgnlMsgId')

  const rawGroupStatus =
    extractNestedText(content, 'OrgnlGrpInfAndSts', 'GrpSts') ||
    extractNestedText(content, 'OrgnlPmtInfAndSts', 'PmtInfSts')

  // Per-transaction statuses: <TxInfAndSts>
  const txElements = extractElements(content, 'TxInfAndSts')
  const transactions: Pain002TransactionStatus[] = txElements.map((tx) => {
    const rawStatus = extractTextContent(tx, 'TxSts')
    return {
      originalEndToEndId: extractTextContent(tx, 'OrgnlEndToEndId'),
      status: mapStatus(rawStatus),
      rawStatus,
      reasonCode:
        extractNestedText(tx, 'StsRsnInf', 'Cd') ||
        extractNestedText(tx, 'Rsn', 'Cd'),
      reasonText: extractTextContent(tx, 'AddtlInf'),
    }
  })

  // Group status resolution: explicit GrpSts wins; otherwise derive from
  // transaction statuses (all rejected → rejected, mixed → partial, …).
  let groupStatus = mapStatus(rawGroupStatus)
  if (groupStatus === 'unknown' && transactions.length > 0) {
    const statuses = new Set(transactions.map((t) => t.status))
    if (statuses.size === 1) {
      groupStatus = transactions[0].status
    } else if (statuses.has('rejected')) {
      groupStatus = 'partially_accepted'
    }
  }

  if (!originalMessageId) {
    issues.push('OrgnlMsgId saknas — statusrapporten kan inte kopplas till en betalfil.')
  }

  return {
    originalMessageId,
    groupStatus,
    rawGroupStatus,
    transactions,
    issues,
  }
}
