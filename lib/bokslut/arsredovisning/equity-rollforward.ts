import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import type { K2FormalReportModel } from '@/lib/bokslut/formal-report/k2-model'
import type { EgenKapitalRow } from './types'

export interface EquityRollforwardResult {
  rows: EgenKapitalRow[]
  warnings: string[]
  reconciled: boolean
}

interface EquityComponents {
  aktiekapital: number
  balanserat: number
  aretsResultat: number
}

function components(
  model: K2FormalReportModel,
  side: 'current' | 'previous',
): EquityComponents | null {
  const amount = (concept: string): number | null => {
    const value = model.br[concept]?.[side]
    return value == null ? null : Number(value)
  }
  const total = model.totals.egetKapital[side]
  const aktiekapital = amount('Aktiekapital')
  const aretsResultat = amount('AretsResultatEgetKapital')
  if (total == null || aktiekapital == null || aretsResultat == null) return null
  return {
    aktiekapital: roundOre(aktiekapital),
    balanserat: roundOre(total - aktiekapital - aretsResultat),
    aretsResultat: roundOre(aretsResultat),
  }
}

function row(
  label: string,
  values: EquityComponents,
  rowKind: EgenKapitalRow['row_kind'],
): EgenKapitalRow {
  return {
    label,
    amount: roundOre(values.aktiekapital + values.balanserat + values.aretsResultat),
    aktiekapital: values.aktiekapital,
    balanserat_resultat: values.balanserat,
    arets_resultat: values.aretsResultat,
    row_kind: rowKind,
  }
}

/**
 * Builds the K2 equity table from verified opening comparatives and explicit
 * equity events. A residual is never called a dividend: it becomes a review
 * row and blocks finalization through the returned warning.
 */
export async function buildK2EquityRollforward(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  model: K2FormalReportModel,
): Promise<EquityRollforwardResult> {
  const warnings: string[] = []
  const opening = components(model, 'previous')
  const closing = components(model, 'current')
  if (!closing) {
    return {
      rows: [],
      warnings: ['Eget kapital kunde inte läsas från den kanoniska balansräkningen.'],
      reconciled: false,
    }
  }
  if (!opening) {
    return {
      rows: [row('Utgående balans', closing, 'closing')],
      warnings: [
        'Verifierad ingående balans för eget kapital saknas. Importera föregående fastställda årsredovisning eller bekräfta historisk eget-kapitalavstämning.',
      ],
      reconciled: false,
    }
  }

  const { data, error } = await supabase
    .from('year_end_equity_events')
    .select('event_type, amount, metadata')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Failed to load equity events: ${error.message}`)

  const rows: EgenKapitalRow[] = [row('Ingående balans', opening, 'opening')]
  let running = { ...opening }
  let hasPriorTransfer = false

  for (const event of data ?? []) {
    const eventType = String(event.event_type)
    const amount = roundOre(Number(event.amount) || 0)
    if (amount === 0 || eventType === 'dividend_proposal') continue

    let movement: EquityComponents = { aktiekapital: 0, balanserat: 0, aretsResultat: 0 }
    let label: string
    if (eventType === 'prior_year_result_transfer') {
      hasPriorTransfer = true
      movement = {
        aktiekapital: 0,
        balanserat: opening.aretsResultat,
        aretsResultat: -opening.aretsResultat,
      }
      label = 'Omföring av föregående års resultat'
    } else if (eventType === 'dividend_decision') {
      movement.balanserat = -Math.abs(amount)
      label = 'Beslutad utdelning'
    } else if (eventType === 'shareholder_contribution') {
      movement.balanserat = Math.abs(amount)
      label = 'Aktieägartillskott'
    } else if (eventType === 'shareholder_contribution_repayment') {
      movement.balanserat = -Math.abs(amount)
      label = 'Återbetalning av aktieägartillskott'
    } else {
      // `equity_other_change` must carry an explicitly signed amount. It is
      // still described as an other movement, never re-labelled as dividend.
      movement.balanserat = amount
      label = 'Övrig dokumenterad förändring'
    }
    running = {
      aktiekapital: roundOre(running.aktiekapital + movement.aktiekapital),
      balanserat: roundOre(running.balanserat + movement.balanserat),
      aretsResultat: roundOre(running.aretsResultat + movement.aretsResultat),
    }
    rows.push(row(label, movement, 'movement'))
  }

  if (opening.aretsResultat !== 0 && !hasPriorTransfer) {
    warnings.push(
      'Föregående års resultat finns i ingående eget kapital men ingen verifierad omföringshändelse är registrerad.',
    )
  }

  const currentResultMovement: EquityComponents = {
    aktiekapital: 0,
    balanserat: 0,
    aretsResultat: closing.aretsResultat,
  }
  running.aretsResultat = roundOre(running.aretsResultat + closing.aretsResultat)
  rows.push(row('Årets resultat', currentResultMovement, 'result'))

  const residual: EquityComponents = {
    aktiekapital: roundOre(closing.aktiekapital - running.aktiekapital),
    balanserat: roundOre(closing.balanserat - running.balanserat),
    aretsResultat: roundOre(closing.aretsResultat - running.aretsResultat),
  }
  const residualTotal = roundOre(
    residual.aktiekapital + residual.balanserat + residual.aretsResultat,
  )
  const hasResidual =
    Math.abs(residual.aktiekapital) >= 0.01 ||
    Math.abs(residual.balanserat) >= 0.01 ||
    Math.abs(residual.aretsResultat) >= 0.01
  if (hasResidual) {
    rows.push(row('Ej klassificerad förändring – manuell granskning krävs', residual, 'movement'))
    warnings.push(
      `Förändringen av eget kapital innehåller en oförklarad restpost på ${residualTotal.toFixed(2)} kr. Den har inte antagits vara utdelning.`,
    )
  }

  rows.push(row('Utgående balans', closing, 'closing'))
  return { rows, warnings, reconciled: !hasResidual && warnings.length === 0 }
}
