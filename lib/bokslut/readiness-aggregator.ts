import type { SupabaseClient } from '@supabase/supabase-js'
import { validateYearEndReadiness } from '@/lib/core/bookkeeping/year-end-service'
import { computeEfDeclarationPreview } from '@/lib/bokslut/enskild-firma/ef-declaration-preview'
import { getCompanyEntityType } from '@/lib/company/entity-type'
import {
  loadYearEndCashReconciliationStatus,
  type YearEndCashReconciliationStatus,
} from '@/lib/bokslut/manual-cash-reconciliation'
import type { YearEndValidation } from '@/types'
import {
  isConfirmationStatus,
  type YearEndControlStatusCode,
} from '@/lib/bokslut/historical-workpapers'

export type ReminderSeverity = 'info' | 'warning'

export interface BokslutReminder {
  /** Stable id so the UI can suppress duplicates and link to docs. */
  code: string
  severity: ReminderSeverity
  /** Swedish, user-facing. */
  message: string
  /** Optional deep link to the relevant resolution surface. */
  href?: string
}

export interface BokslutBlockerDetail {
  /** Stable machine code from year_end_db_blockers. */
  code: string
  message: string
  /** Exact total count for count-based checks (B11) — never a capped sample. */
  count: number
  /** Whether the underlying check completed. False ⇒ the check itself failed
   *  and the close is blocked until it can run (fail closed, B04). */
  checkCompleted: boolean
  /** Canonical resolution surface when the blocker has a safe guided flow. */
  href?: string
  actionLabel?: string
  /** Confirmation means no accounting correction is required. */
  resolutionKind?: 'confirmation' | 'accounting_correction'
}

export interface YearEndControlStatus {
  control_code: string
  label: string
  status: YearEndControlStatusCode
  ledger_balance: number | null
  support_balance: number | null
  difference: number | null
  is_stale: boolean
  is_blocking: boolean
  message: string
  available_actions: string[]
  metadata: Record<string, unknown>
  href: string
  source_type: string
  verification_method: string | null
  evidence_count: number
}

export interface BokslutReadinessReport {
  /** True ⇔ no blocking errors AND every check completed. */
  ready: boolean
  /** Blocking errors that prevent year-end execution. */
  blockers: string[]
  /** Structured blocker details with exact counts (B11). */
  blockerDetails: BokslutBlockerDetail[]
  /** Non-blocking warnings (from year-end-service). */
  warnings: string[]
  /** Soft reminders (manual steps the user should consider). */
  reminders: BokslutReminder[]
  /** Convenience counts for the UI header. */
  draftCount: number
  unexplainedGapCount: number
  trialBalanceBalanced: boolean
  /** Bank reconciliation snapshot for the period. */
  reconciliation: {
    is_reconciled: boolean
    unmatched_transaction_count: number
    unmatched_gl_line_count: number
    difference: number
  } | null
  /** Per-account canonical status, including manual SIE-only reconciliations. */
  cashReconciliations: YearEndCashReconciliationStatus[]
  /** Canonical server-computed support-ledger and legal-identity controls. */
  controls?: YearEndControlStatus[]
  /** Controls that only need review/confirmation, not a corrective voucher. */
  confirmationCount: number
  /** Period metadata so the UI can show name/dates without an extra fetch. */
  period: {
    id: string
    name: string
    period_start: string
    period_end: string
    is_closed: boolean
    locked_at: string | null
    closing_entry_id: string | null
  }
  /** Entity type drives which dispositions apply (e.g. bolagsskatt only for AB). */
  entityType: 'aktiebolag' | 'enskild_firma' | 'handelsbolag' | 'kommanditbolag' | 'ekonomisk_forening'
  /** The full raw validation, for callers that want every field. */
  rawValidation: YearEndValidation
}

/**
 * Single-fetch aggregator that drives the bokslut wizard's preflight step.
 *
 * The blocking checks are computed by year_end_db_blockers() — the SAME
 * database function the atomic close RPC re-runs inside its locked
 * transaction (B03), so what the UI approves is exactly what the close
 * enforces. Every check fails CLOSED (B04): a database error or unknown
 * result becomes a blocker with a clear explanation, never an empty list.
 */
export async function buildBokslutReadinessReport(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  fiscalPeriodId: string,
): Promise<BokslutReadinessReport> {
  // Fetch period + entity type in parallel with the heavy validation.
  const [periodResult, entityTypeResult, validation] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed, locked_at, closing_entry_id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    // Canonical legal form (B13) — companies.entity_type, no silent fallback.
    getCompanyEntityType(supabase, companyId).then(
      (t) => ({ ok: true as const, value: t }),
      (err: Error) => ({ ok: false as const, error: err.message }),
    ),
    validateYearEndReadiness(supabase, companyId, userId, fiscalPeriodId),
  ])

  if (periodResult.error || !periodResult.data) {
    throw new Error('Fiscal period not found')
  }

  const period = periodResult.data
  const reconciliationHref = `/bookkeeping/year-end/reconciliation?period=${encodeURIComponent(
    fiscalPeriodId,
  )}&company_id=${encodeURIComponent(companyId)}`
  const historicalSupportHref = `/bookkeeping/year-end/historical-support?period=${encodeURIComponent(
    fiscalPeriodId,
  )}&company_id=${encodeURIComponent(companyId)}`

  const blockerDetails: BokslutBlockerDetail[] = []

  if (!entityTypeResult.ok) {
    // Missing/unreadable legal form blocks the close with a clear explanation
    // (B13) — never a silent AB assumption.
    blockerDetails.push({
      code: 'entity_type_missing',
      message: entityTypeResult.error,
      count: 0,
      checkCompleted: false,
    })
  }
  const entityType = (entityTypeResult.ok
    ? entityTypeResult.value
    : 'aktiebolag') as BokslutReadinessReport['entityType']

  // Operational + asset blockers from the database — the same function the
  // atomic close re-runs inside its transaction. A query failure here is a
  // BLOCKER (fail closed, B04), not a silent pass.
  const { data: dbBlockers, error: dbBlockersError } = await supabase.rpc(
    'year_end_db_blockers',
    { p_company_id: companyId, p_fiscal_period_id: fiscalPeriodId },
  )

  if (dbBlockersError) {
    blockerDetails.push({
      code: 'readiness_check_failed',
      message: 'Beredskapskontrollen kunde inte genomföras just nu. Bokslut blockeras tills kontrollen kan köras.',
      count: 0,
      checkCompleted: false,
    })
  } else {
    for (const row of (dbBlockers ?? []) as Array<{
      code: string
      message: string
      detail_count: number | null
    }>) {
      blockerDetails.push({
        code: row.code,
        message: row.message,
        count: row.detail_count ?? 0,
        checkCompleted: true,
        ...(row.code.startsWith('bank_') || row.code.startsWith('manual_cash_')
          ? {
              href: reconciliationHref,
              actionLabel: 'Öppna avstämning',
            }
          : /^(company_identity|company_snapshot|customer_receivables|supplier_payables|equity|tax|vat|profit_disposition|historical_)/.test(
                row.code,
              )
            ? {
                href: historicalSupportHref,
                actionLabel: 'Öppna bokslutsunderlag',
              }
            : {}),
      })
    }
  }

  let controls: YearEndControlStatus[] = []
  const { data: controlRows, error: controlsError } = await supabase.rpc(
    'year_end_control_status',
    { p_company_id: companyId, p_fiscal_period_id: fiscalPeriodId },
  )
  if (controlsError) {
    blockerDetails.push({
      code: 'year_end_control_status_failed',
      message: 'Bokslutets stödregister kunde inte kontrolleras just nu. Bokslut blockeras tills kontrollen kan köras.',
      count: 0,
      checkCompleted: false,
      href: historicalSupportHref,
      actionLabel: 'Öppna bokslutsunderlag',
    })
  } else {
    controls = ((controlRows ?? []) as Array<{
      control_code: string
      control_category: string
      status: YearEndControlStatusCode
      ledger_amount: number | string | null
      supporting_register_amount: number | string | null
      difference: number | string | null
      is_stale: boolean
      is_blocking: boolean
      message: string
      available_actions: string[] | null
      metadata: Record<string, unknown> | null
      source_type: string | null
      verification_method: string | null
      evidence_count: number | null
    }>)
      .filter((row) => typeof row.control_code === 'string')
      .map((row) => ({
      control_code: row.control_code,
      label: controlLabel(row.control_category),
      status: row.status,
      ledger_balance: row.ledger_amount == null ? null : Number(row.ledger_amount),
      support_balance:
        row.supporting_register_amount == null
          ? null
          : Number(row.supporting_register_amount),
      difference: row.difference == null ? null : Number(row.difference),
      is_stale: row.is_stale,
      is_blocking: row.is_blocking,
      message: row.message,
      available_actions: row.available_actions ?? [],
      metadata: row.metadata ?? {},
      source_type: row.source_type ?? 'system_calculation',
      verification_method: row.verification_method,
      evidence_count: row.evidence_count ?? 0,
      href:
        row.control_code === 'bank'
          ? reconciliationHref
          : `${historicalSupportHref}&focus=${encodeURIComponent(row.control_code)}`,
    }))
  }

  // Canonical per-account reconciliation status. This RPC is also consumed by
  // year_end_db_blockers(), which execute_year_end_closing() re-runs inside
  // the locked transaction. It supports both strict bank matching and the
  // append-only manual SIE/no-bank path without creating a second readiness
  // engine in the browser.
  let reconciliation: BokslutReadinessReport['reconciliation'] = null
  let cashReconciliations: YearEndCashReconciliationStatus[] = []
  try {
    cashReconciliations = await loadYearEndCashReconciliationStatus(
      supabase,
      companyId,
      fiscalPeriodId,
    )
    reconciliation = {
      is_reconciled:
        cashReconciliations.length > 0
        && cashReconciliations.every((status) => status.is_reconciled),
      unmatched_transaction_count: cashReconciliations.reduce(
        (sum, status) => sum + status.unmatched_transaction_count,
        0,
      ),
      unmatched_gl_line_count: cashReconciliations.reduce(
        (sum, status) => sum + status.unmatched_gl_line_count,
        0,
      ),
      // Sum absolute differences so two account errors can never cancel in
      // the UI summary. The database evaluates each account independently.
      difference: cashReconciliations.reduce(
        (sum, status) => sum + Math.abs(Number(status.difference ?? 0)),
        0,
      ),
    }
  } catch (err) {
    blockerDetails.push({
      code: 'reconciliation_check_failed',
      message: `Bankavstämningen kunde inte kontrolleras (${err instanceof Error ? err.message : 'okänt fel'}). Bokslut blockeras tills kontrollen kan köras.`,
      count: 0,
      checkCompleted: false,
    })
  }

  const reminders: BokslutReminder[] = []

  if (reconciliation && !reconciliation.is_reconciled) {
    reminders.push({
      code: 'bank_reconciliation_incomplete',
      severity: 'warning',
      message:
        reconciliation.unmatched_transaction_count > 0
          ? `${reconciliation.unmatched_transaction_count} banktransaktioner är inte matchade. Avstäm banken innan bokslut.`
          : reconciliation.unmatched_gl_line_count > 0
            ? `${reconciliation.unmatched_gl_line_count} huvudboksrader på bankkontot är inte matchade. Avstäm banken innan bokslut.`
            : cashReconciliations.some(
                  (status) =>
                    status.reconciliation_mode === 'manual' && !status.is_reconciled,
                )
              ? 'Ett eller flera likvidkonton saknar giltig manuell saldoverifiering per balansdagen.'
              : `Bankavstämningen visar en differens på ${reconciliation.difference.toFixed(2)} kr.`,
      href: reconciliationHref,
    })
  }

  // Periodiseringar (accruals) are still manual — no wizard step ships in
  // Phases 1-3. Depreciation, bolagsskatt and periodiseringsfond now have
  // dedicated calculators (DepreciationPanel + DispositionsStep) so they're
  // no longer surfaced as manual reminders.
  reminders.push({
    code: 'accruals_manual',
    severity: 'info',
    message:
      'Periodiseringar (förutbetalda kostnader 17xx, upplupna kostnader 29xx) bokas manuellt. Tänk på att vända dem 1 januari nästa år.',
  })

  if (entityType === 'enskild_firma') {
    // Pre-compute the EF declaration so the wizard's overview reflects what
    // the user will see when they reach the dispositions step. Egenavgifter,
    // räntefördelning, periodiseringsfond-EF and expansionsfond are NOT
    // booked — they go into the NE-bilaga / INK1. This reminder explains
    // the BFL distinction.
    reminders.push({
      code: 'ef_skatt_via_ne',
      severity: 'info',
      message:
        'Egenavgifter, räntefördelning, periodiseringsfond och expansionsfond beräknas i NE-bilagan, inte bokförs. Skatten betalas privat av ägaren.',
    })

    // Surface a soft warning when kapitalunderlag is missing AND the booked
    // surplus is large enough to make positive räntefördelning meaningful
    // (> 50 000 kr — the spärrbeloppet). This is non-blocking but actionable:
    // the user should enter their IB equity on the dispositions step.
    try {
      const preview = await computeEfDeclarationPreview(supabase, companyId, fiscalPeriodId)
      if (preview.bookedSurplus > 50_000) {
        reminders.push({
          code: 'ef_kapitalunderlag_missing',
          severity: 'warning',
          message:
            'Kapitalunderlag (IB eget kapital) saknas — räntefördelning beräknas inte. Fyll i på dispositionssteget för att utnyttja skattefördelen.',
        })
      }
    } catch {
      // EF preview is informational — never block readiness on it.
    }
  }

  // De-duplicate: the legal validator and the DB function overlap on several
  // checks (drafts, gaps, TB, next-period OB). The message texts differ, so
  // keep validator errors verbatim and DB blockers by code.
  const controlByCode = new Map(controls.map((control) => [control.control_code, control]))
  for (const detail of blockerDetails) {
    const control = controlByCode.get(detail.code)
    if (!control) continue
    detail.resolutionKind = isConfirmationStatus(control.status)
      ? 'confirmation'
      : 'accounting_correction'
  }

  const blockers = [
    ...validation.errors,
    ...blockerDetails
      .filter((detail) => !controlByCode.has(detail.code))
      .map((detail) => detail.message),
  ]
  const confirmationCount = controls.filter((control) =>
    isConfirmationStatus(control.status),
  ).length
  const accountingErrorCount = controls.filter((control) =>
    control.is_blocking && !isConfirmationStatus(control.status),
  ).length

  return {
    ready: blockers.length === 0
      && confirmationCount === 0
      && accountingErrorCount === 0,
    blockers,
    blockerDetails,
    warnings: validation.warnings,
    reminders,
    draftCount: validation.draftCount,
    unexplainedGapCount: validation.unexplainedGaps.length,
    trialBalanceBalanced: validation.trialBalanceBalanced,
    reconciliation,
    cashReconciliations,
    controls,
    confirmationCount,
    period,
    entityType,
    rawValidation: validation,
  }
}

function controlLabel(category: string): string {
  return {
    company_identity: 'Företagsidentitet',
    customer_receivables: 'Kundreskontra',
    supplier_payables: 'Leverantörsreskontra',
    bank: 'Bank och kassa',
    equity: 'Eget kapital',
    tax: 'Skatt',
    vat: 'Moms',
    profit_disposition: 'Resultatdisposition',
  }[category] ?? category
}
