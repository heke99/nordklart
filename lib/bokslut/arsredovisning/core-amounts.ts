import type { ArsredovisningData } from './types'
import type { IxbrlArsredovisningInput } from '@/lib/bokslut/ixbrl/types'

export interface AnnualReportCoreAmounts {
  net_revenue: number
  result_after_financial: number
  result_before_tax: number
  tax: number
  net_result: number
  total_assets: number
  total_equity_liabilities: number
  equity: number
}

export function coreAmountsFromAnnualReport(
  data: ArsredovisningData,
): AnnualReportCoreAmounts {
  if (!data.formal_report) throw new Error('Canonical formal report is missing')
  const model = data.formal_report
  return {
    net_revenue: model.rr.Nettoomsattning?.current ?? 0,
    result_after_financial: model.totals.resultatEfterFinansiellaPoster.current,
    result_before_tax: model.totals.resultatForeSkatt.current,
    tax: model.rr.SkattAretsResultat?.current ?? 0,
    net_result: model.totals.aretsResultat.current,
    total_assets: model.totals.tillgangar.current,
    total_equity_liabilities: model.totals.egetKapitalSkulder.current,
    equity: model.totals.egetKapital.current,
  }
}

export function coreAmountsFromIxbrl(
  input: IxbrlArsredovisningInput,
): AnnualReportCoreAmounts {
  return {
    net_revenue: input.rr.Nettoomsattning?.current ?? 0,
    result_after_financial: input.totals.resultatEfterFinansiellaPoster.current,
    result_before_tax: input.totals.resultatForeSkatt.current,
    tax: input.rr.SkattAretsResultat?.current ?? 0,
    net_result: input.totals.aretsResultat.current,
    total_assets: input.totals.tillgangar.current,
    total_equity_liabilities: input.totals.egetKapitalSkulder.current,
    equity: input.totals.egetKapital.current,
  }
}

export function compareCoreAmounts(
  pdf: AnnualReportCoreAmounts,
  ixbrl: AnnualReportCoreAmounts,
): {
  match: boolean
  fields: Record<string, { pdf: number; ixbrl: number; match: boolean }>
} {
  const fields = Object.fromEntries(
    (Object.keys(pdf) as Array<keyof AnnualReportCoreAmounts>).map((key) => [
      key,
      { pdf: pdf[key], ixbrl: ixbrl[key], match: pdf[key] === ixbrl[key] },
    ]),
  ) as Record<string, { pdf: number; ixbrl: number; match: boolean }>
  return { match: Object.values(fields).every((field) => field.match), fields }
}
