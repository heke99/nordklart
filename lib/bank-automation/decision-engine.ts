export type MatchCandidateInput = {
  type: 'customer_invoice' | 'supplier_invoice' | 'bank_fee' | 'tax_payment' | 'salary' | 'own_transfer' | 'manual_rule' | 'unknown'
  score: number
  reasonCodes?: string[]
  ruleAllowsAutobook?: boolean
  proposedAccount?: string
  proposedVatCode?: string
}

export type BankTransactionForDecision = {
  amount: number
  description: string
  currency?: string
  ocrReference?: string | null
  counterpartyName?: string | null
  candidates?: MatchCandidateInput[]
}

export type AutomationDecision = {
  decision: 'auto_book' | 'suggest' | 'review'
  confidence: number
  riskLevel: 'low' | 'normal' | 'high'
  reasonCodes: string[]
  selectedCandidate: MatchCandidateInput | null
}

const AUTOBOOK_THRESHOLD = 95
const SUGGEST_THRESHOLD = 70

function clampScore(score: number) {
  if (!Number.isFinite(score)) return 0
  return Math.max(0, Math.min(100, Math.round(score)))
}

function inferFallbackCandidate(input: BankTransactionForDecision): MatchCandidateInput {
  const description = input.description.toLowerCase()
  if (description.includes('bankavgift') || description.includes('bank fee') || description.includes('kortavgift')) {
    return { type: 'bank_fee', score: 96, reasonCodes: ['known_bank_fee_text'], ruleAllowsAutobook: true, proposedAccount: '6570' }
  }
  if (input.ocrReference && /\d{6,}/.test(input.ocrReference)) {
    return { type: input.amount > 0 ? 'customer_invoice' : 'supplier_invoice', score: 82, reasonCodes: ['ocr_present'] }
  }
  if (input.counterpartyName && Math.abs(input.amount) > 0) {
    return { type: 'unknown', score: 55, reasonCodes: ['counterparty_present'] }
  }
  return { type: 'unknown', score: 25, reasonCodes: ['insufficient_match_data'] }
}

function riskFor(candidate: MatchCandidateInput, confidence: number): 'low' | 'normal' | 'high' {
  if (candidate.type === 'unknown') return 'high'
  if (candidate.type === 'bank_fee' && confidence >= AUTOBOOK_THRESHOLD) return 'low'
  if (candidate.type === 'own_transfer') return confidence >= AUTOBOOK_THRESHOLD ? 'normal' : 'high'
  if (confidence >= AUTOBOOK_THRESHOLD) return 'normal'
  return confidence >= SUGGEST_THRESHOLD ? 'normal' : 'high'
}

export function evaluateBankAutomationDecision(input: BankTransactionForDecision): AutomationDecision {
  const selected = [...(input.candidates ?? []), inferFallbackCandidate(input)]
    .map((candidate) => ({ ...candidate, score: clampScore(candidate.score) }))
    .sort((a, b) => b.score - a.score)[0]

  const confidence = selected?.score ?? 0
  const riskLevel = selected ? riskFor(selected, confidence) : 'high'
  const reasonCodes = Array.from(new Set([...(selected?.reasonCodes ?? []), `confidence_${confidence}`]))

  if (confidence >= AUTOBOOK_THRESHOLD && selected?.ruleAllowsAutobook === true && riskLevel !== 'high') {
    return { decision: 'auto_book', confidence, riskLevel, reasonCodes, selectedCandidate: selected }
  }
  if (confidence >= SUGGEST_THRESHOLD) {
    return { decision: 'suggest', confidence, riskLevel, reasonCodes, selectedCandidate: selected ?? null }
  }
  return { decision: 'review', confidence, riskLevel, reasonCodes, selectedCandidate: selected ?? null }
}

export function automationStatusFromDecision(decision: AutomationDecision['decision']) {
  if (decision === 'auto_book') return 'auto_booked'
  if (decision === 'suggest') return 'suggested'
  return 'needs_review'
}

export function buildProviderTransactionId(providerCode: string, accountId: string, rawId: string) {
  return [providerCode, accountId, rawId].map((part) => part.trim()).join(':')
}
