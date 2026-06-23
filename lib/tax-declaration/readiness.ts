import 'server-only'

export type DeclarationIssueSeverity = 'ok' | 'warning' | 'blocker'

export interface DeclarationReadinessIssue {
  code: string
  severity: DeclarationIssueSeverity
  message: string
  source?: string
}

export interface DeclarationReadiness {
  score: number
  status: 'draft' | 'needs_input' | 'needs_review' | 'blocked' | 'ready_to_export'
  completed: DeclarationReadinessIssue[]
  warnings: DeclarationReadinessIssue[]
  blockers: DeclarationReadinessIssue[]
}

export function buildDeclarationReadiness(issues: DeclarationReadinessIssue[]): DeclarationReadiness {
  const completed = issues.filter((issue) => issue.severity === 'ok')
  const warnings = issues.filter((issue) => issue.severity === 'warning')
  const blockers = issues.filter((issue) => issue.severity === 'blocker')
  const penalty = blockers.length * 25 + warnings.length * 7
  const score = Math.max(0, Math.min(100, 100 - penalty))
  const status = blockers.length > 0
    ? 'blocked'
    : warnings.length > 0
      ? 'needs_review'
      : 'ready_to_export'

  return { score, status, completed, warnings, blockers }
}

export function issue(code: string, severity: DeclarationIssueSeverity, message: string, source?: string): DeclarationReadinessIssue {
  return { code, severity, message, ...(source ? { source } : {}) }
}
