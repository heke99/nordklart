import type { SupabaseClient } from '@supabase/supabase-js'
import { getCompanyEntityType } from '@/lib/company/entity-type'
import { buildProjectedLedger } from '@/lib/core/bookkeeping/projected-ledger'
import { getYearEndRuleset } from '@/lib/core/bookkeeping/year-end-staging'
import { roundOre } from '@/lib/money'
import { calculateBolagsskatt } from './tax-provision/bolagsskatt-calculator'
import { calculateSarskildLoneskatt } from './tax-provision/sarskild-loneskatt-calculator'
import {
  computeLatentTax,
  LATENT_TAX_EXPENSE_ACCOUNT,
  LATENT_TAX_LIABILITY_ACCOUNT,
  proposeLatentTaxChange,
} from './tax-provision/latent-tax-calculator'
import {
  listExistingPeriodiseringsfonder,
  proposeAvsattning,
  proposeAteforing,
} from './reserves/periodiseringsfond-service'
import type { DispositionsProposal, ProposedDisposition } from './types'
import type { AccountingFramework, TrialBalanceRow } from '@/types'

/**
 * Shared core of the GET /bokslutsdispositioner endpoint, lifted out so the
 * MCP tool can call the same builder without duplicating the proposal logic.
 * The API route and the MCP tool both hand its output to the caller, who
 * picks which proposals to commit via the POST endpoint.
 */
export async function buildDispositionsProposal(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<DispositionsProposal> {
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (periodError || !period) {
    throw new Error('Fiscal period not found')
  }

  // Canonical legal form (B13) — companies.entity_type, no silent AB fallback.
  const entityType = (await getCompanyEntityType(
    supabase,
    companyId,
  )) as DispositionsProposal['entityType']

  if (entityType !== 'aktiebolag') {
    // Non-AB entities (enskild firma, handelsbolag, etc.) do not produce
    // bookable bokslutsdispositioner — bolagsskatt, periodiseringsfond and
    // SLP are AB-only mechanisms. EF tax mechanisms (egenavgifter,
    // räntefördelning, periodiseringsfond-EF, expansionsfond) are
    // declaration-only and surface through the dedicated
    // /api/bookkeeping/fiscal-periods/[id]/ef-declaration endpoint and the
    // EfDeclarationSection in the wizard — they never produce journal
    // entries, so they have no place in this list.
    const projected = await buildProjectedLedger(supabase, companyId, fiscalPeriodId, {
      excludeGroups: ['disposition'],
    })
    return {
      entityType,
      fiscalPeriod: period,
      netResultBefore: projected.resultBeforeTax(),
      proposals: [],
    }
  }

  // Look up the accounting framework — K3 (BFNAR 2012:1) triggers the
  // uppskjuten-skatt provision step; K2 skips it.
  const { data: companyRow } = await supabase
    .from('companies')
    .select('accounting_framework')
    .eq('id', companyId)
    .maybeSingle()
  const accountingFramework: AccountingFramework =
    (companyRow as { accounting_framework?: AccountingFramework } | null)?.accounting_framework
      === 'k3'
      ? 'k3'
      : 'k2'

  const fiscalYear = parseInt(period.period_end.slice(0, 4), 10)
  const [ruleset, projected] = await Promise.all([
    getYearEndRuleset(supabase, fiscalYear),
    buildProjectedLedger(supabase, companyId, fiscalPeriodId, {
      excludeGroups: ['disposition'],
    }),
  ])
  const resultBeforeTax = projected.resultBeforeTax()

  const proposals: ProposedDisposition[] = []

  const existingFonder = await listExistingPeriodiseringsfonder(supabase, companyId, period.period_end)
  const ateforing = proposeAteforing(existingFonder, {
    schablonintaktRate: ruleset.schablonintakt_rate,
  })
  proposals.push(...ateforing.proposals)
  for (const proposal of ateforing.proposals) projected.applyLines(proposal.lines)

  const taxableBeforeAvsattning =
    projected.resultBeforeTax() +
    ateforing.schablonintaktAmount
  const avsattning = proposeAvsattning({
    skattemassigtResultatBeforeAvsattning: taxableBeforeAvsattning,
    fiscalYear,
    rate: ruleset.periodiseringsfond_rate,
  })
  if (avsattning) {
    proposals.push(avsattning)
    projected.applyLines(avsattning.lines)
  }

  const slp = await calculateSarskildLoneskatt(supabase, companyId, fiscalPeriodId, {
    pensionCostsBooked: projected.debitMovementInRange('7410', '7419'),
    rate: ruleset.slp_rate,
  })
  if (slp) {
    proposals.push(slp)
    projected.applyLines(slp.lines)
  }

  const bolagsskatt = await calculateBolagsskatt(supabase, companyId, fiscalPeriodId, {
    resultBeforeTax: projected.resultBeforeTax(),
    taxRate: ruleset.corporate_tax_rate,
    manualAdjustments: {
      schablonintaktPeriodiseringsfond: ateforing.schablonintaktAmount,
    },
  })
  if (bolagsskatt) {
    proposals.push(bolagsskatt)
    if (bolagsskatt.lines.length > 0) projected.applyLines(bolagsskatt.lines)
  }

  // K3 only: split obeskattade reserver into the 79.4 % equity portion and
  // the 20.6 % uppskjuten skatteskuld. We sum the projected 21xx balance
  // AFTER the dispositions above have been applied so the latent-tax
  // amount reflects the closing position — anything else would diverge
  // from the BR the user sees in the preview.
  if (accountingFramework === 'k3') {
    const latentTax = await buildLatentTaxProposal({
      supabase,
      companyId,
      fiscalPeriodId,
      projectedRows: projected.rows,
      taxRate: ruleset.corporate_tax_rate,
    })
    if (latentTax) proposals.push(latentTax)
  }

  return {
    entityType,
    fiscalPeriod: period,
    netResultBefore: resultBeforeTax,
    rulesetVersion: ruleset.version,
    proposals,
  }
}

/**
 * Compose the K3 uppskjuten-skatt proposal.
 *
 * The latent tax provision must reflect the *closing* obeskattade-reserver
 * balance, so we pull the current 21xx balance from the trial balance and
 * adjust it for any 21xx-touching dispositions that haven't yet posted
 * (avsättning ↑, återföring ↓). 2240's current balance is the existing
 * provision; the delta becomes the new verifikat.
 */
export async function buildLatentTaxProposal(params: {
  supabase: SupabaseClient
  companyId: string
  fiscalPeriodId: string
  /** Optional — additional 21xx-touching dispositions that have NOT yet been
   *  posted but will be in the same batch. The TB already reflects everything
   *  posted, so leave this empty if the latent-tax run is sequenced after the
   *  21xx postings (the API route's case). */
  proposalsBeforeLatentTax?: ProposedDisposition[]
  /** Projected rows including earlier staged and newly selected adjustments. */
  projectedRows?: TrialBalanceRow[]
  /** Versioned corporate/deferred-tax rate from the fiscal year's ruleset. */
  taxRate: number
}): Promise<ProposedDisposition | null> {
  const {
    supabase,
    companyId,
    fiscalPeriodId,
    proposalsBeforeLatentTax = [],
    projectedRows,
    taxRate,
  } = params
  const rows = projectedRows ?? (
    await buildProjectedLedger(supabase, companyId, fiscalPeriodId)
  ).rows

  // 21xx — obeskattade reserver (credit-normal, so we measure credit − debit).
  let untaxedReserves = rows
    .filter((r) => r.account_number.startsWith('21'))
    .reduce((s, r) => s + (r.closing_credit - r.closing_debit), 0)

  // Pending 21xx postings from the proposals that will commit alongside
  // latent tax. Avsättning adds to the reserves (credit 21xx), återföring
  // removes (debit 21xx).
  for (const p of proposalsBeforeLatentTax) {
    if (
      p.kind !== 'periodiseringsfond_avsattning'
      && p.kind !== 'periodiseringsfond_ateforing'
    ) continue
    for (const line of p.lines) {
      if (!line.account_number.startsWith('21')) continue
      untaxedReserves += (line.credit_amount ?? 0) - (line.debit_amount ?? 0)
    }
  }

  // Current 2240 balance — credit-normal. Equal to existing latent tax.
  const current2240 = rows
    .filter((r) => r.account_number === LATENT_TAX_LIABILITY_ACCOUNT)
    .reduce((s, r) => s + (r.closing_credit - r.closing_debit), 0)

  const split = computeLatentTax({ untaxedReserves, taxRate })
  const lines = proposeLatentTaxChange(current2240, split.liabilityPortion)
  if (!lines) return null

  const delta = roundOre(split.liabilityPortion - current2240)
  const amount = Math.abs(delta)
  const direction = delta > 0 ? 'avsättning' : 'återföring'
  const taxRateLabel = `${roundOre(taxRate * 100).toLocaleString('sv-SE')} %`

  return {
    kind: 'uppskjuten_skatt',
    label: 'Uppskjuten skatt (K3)',
    description:
      delta > 0
        ? `Avsättning till uppskjuten skatteskuld ${taxRateLabel} av obeskattade reserver. Debet ${LATENT_TAX_EXPENSE_ACCOUNT}, kredit ${LATENT_TAX_LIABILITY_ACCOUNT}.`
        : `Återföring av uppskjuten skatteskuld när obeskattade reserver minskar. Debet ${LATENT_TAX_LIABILITY_ACCOUNT}, kredit ${LATENT_TAX_EXPENSE_ACCOUNT}.`,
    amount,
    lines,
    warnings: [],
    computation: {
      untaxedReserves,
      taxRate,
      target2240: split.liabilityPortion,
      current2240,
      delta,
      direction,
      equityPortion: split.equityPortion,
    },
  }
}
