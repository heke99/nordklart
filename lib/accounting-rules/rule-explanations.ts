import type { RuleDecision } from './types'

export function explainDecision(decision: RuleDecision): string {
  const parts = [decision.explanationSv]
  if (decision.accountNumber) parts.push(`Föreslaget BAS-konto: ${decision.accountNumber}.`)
  if (decision.reviewSeverity === 'warning' || decision.reviewSeverity === 'danger' || decision.reviewSeverity === 'blocking') {
    parts.push('Kontroll krävs innan bokföring.')
  }
  if (decision.requiredEvidence.length > 0) {
    parts.push(`Behöver underlag: ${decision.requiredEvidence.map((e) => e.labelSv).join(', ')}.`)
  }
  return parts.join(' ')
}
