import {
  K2_BR_MAPPINGS,
  K2_MAPPING_VERSION,
  K2_RR_MAPPINGS,
  mapTrialBalancesToK2,
  type K2MappingResult,
  type TrialBalancePair,
} from '@/lib/bokslut/ixbrl/k2-mapper'
import { K2_AB_RISBS_2024_09_12 } from '@/lib/bokslut/ixbrl/taxonomy/entry-points'
import { getConcept, getRegistry } from '@/lib/bokslut/ixbrl/taxonomy/registry'
import type { BalanceSheetLine, IncomeStatementLine } from '@/lib/bokslut/arsredovisning/types'
import type { ConceptAmount } from '@/lib/bokslut/ixbrl/types'

export type FormalReportType = 'income_statement' | 'balance_sheet'
export type FormalNodeKind = 'section' | 'line' | 'subtotal' | 'total'
export type FormalBalanceSide = 'assets' | 'equity_liabilities' | null

export interface K2FormalReportNode {
  key: string
  framework: 'k2'
  reportType: FormalReportType
  kind: FormalNodeKind
  label: string
  taxonomyConcept: string | null
  parentKey: string | null
  balanceSide: FormalBalanceSide
  order: number
  signRule: 'natural' | 'display_negative'
  current: number
  previous: number | null
  displayCurrent: number
  displayPrevious: number | null
  required: boolean
  visible: boolean
}

export interface K2FormalReportModel {
  modelVersion: 'k2-risbs-2024-09-12-v1'
  mappingVersion: typeof K2_MAPPING_VERSION
  framework: 'k2'
  taxonomyEntryPointId: string
  taxonomyRegistryId: string
  nodes: K2FormalReportNode[]
  rr: K2MappingResult['rr']
  br: K2MappingResult['br']
  totals: K2MappingResult['totals']
  warnings: string[]
  unmappedAccounts: K2MappingResult['unmappedAccounts']
}

type TotalKey = keyof K2MappingResult['totals']

type SequenceEntry =
  | { kind: 'section'; key: string; label: string; side?: FormalBalanceSide }
  | { kind: 'line'; concept: string; side?: FormalBalanceSide; parent: string; label?: string; required?: boolean }
  | {
      kind: 'subtotal' | 'total'
      key: TotalKey
      concept: string | null
      parent: string | null
      side?: FormalBalanceSide
      label: string
      signRule?: K2FormalReportNode['signRule']
    }

const RR_GROUPS = {
  income: K2_RR_MAPPINGS.slice(0, 4).map((m) => m.concept),
  costs: K2_RR_MAPPINGS.slice(4, 11).map((m) => m.concept),
  finance: K2_RR_MAPPINGS.slice(11, 18).map((m) => m.concept),
  dispositions: K2_RR_MAPPINGS.slice(18, 23).map((m) => m.concept),
  taxes: K2_RR_MAPPINGS.slice(23).map((m) => m.concept),
}

const RR_SEQUENCE: SequenceEntry[] = [
  { kind: 'section', key: 'rr-income', label: 'Rörelseintäkter' },
  ...RR_GROUPS.income.map((concept) => ({ kind: 'line' as const, concept, parent: 'rr-income' })),
  {
    kind: 'subtotal',
    key: 'rorelseintakter',
    concept: 'RorelseintakterLagerforandringarMm',
    parent: 'rr-income',
    label: 'Summa rörelseintäkter, lagerförändringar m.m.',
  },
  { kind: 'section', key: 'rr-costs', label: 'Rörelsekostnader' },
  ...RR_GROUPS.costs.map((concept) => ({ kind: 'line' as const, concept, parent: 'rr-costs' })),
  {
    kind: 'subtotal',
    key: 'rorelsekostnader',
    concept: 'Rorelsekostnader',
    parent: 'rr-costs',
    label: 'Summa rörelsekostnader',
    signRule: 'display_negative',
  },
  {
    kind: 'subtotal',
    key: 'rorelseresultat',
    concept: 'Rorelseresultat',
    parent: null,
    label: 'Rörelseresultat',
  },
  { kind: 'section', key: 'rr-finance', label: 'Finansiella poster' },
  ...RR_GROUPS.finance.map((concept) => ({ kind: 'line' as const, concept, parent: 'rr-finance' })),
  {
    kind: 'subtotal',
    key: 'finansiellaPoster',
    concept: 'FinansiellaPoster',
    parent: 'rr-finance',
    label: 'Resultat från finansiella poster',
  },
  {
    kind: 'subtotal',
    key: 'resultatEfterFinansiellaPoster',
    concept: 'ResultatEfterFinansiellaPoster',
    parent: null,
    label: 'Resultat efter finansiella poster',
  },
  { kind: 'section', key: 'rr-dispositions', label: 'Bokslutsdispositioner' },
  ...RR_GROUPS.dispositions.map((concept) => ({ kind: 'line' as const, concept, parent: 'rr-dispositions' })),
  {
    kind: 'subtotal',
    key: 'bokslutsdispositioner',
    concept: 'Bokslutsdispositioner',
    parent: 'rr-dispositions',
    label: 'Summa bokslutsdispositioner',
  },
  {
    kind: 'subtotal',
    key: 'resultatForeSkatt',
    concept: 'ResultatForeSkatt',
    parent: null,
    label: 'Resultat före skatt',
  },
  { kind: 'section', key: 'rr-taxes', label: 'Skatt' },
  ...RR_GROUPS.taxes.map((concept) => ({ kind: 'line' as const, concept, parent: 'rr-taxes' })),
  {
    kind: 'total',
    key: 'aretsResultat',
    concept: 'AretsResultat',
    parent: null,
    label: 'Årets resultat',
  },
]

function conceptsBetween(start: string, endExclusive?: string): string[] {
  const startIndex = K2_BR_MAPPINGS.findIndex((mapping) => mapping.concept === start)
  if (startIndex < 0) throw new Error(`K2 formal report: unknown BR boundary ${start}`)
  const endIndex = endExclusive
    ? K2_BR_MAPPINGS.findIndex((mapping) => mapping.concept === endExclusive)
    : K2_BR_MAPPINGS.length
  if (endIndex < 0) throw new Error(`K2 formal report: unknown BR boundary ${endExclusive}`)
  return K2_BR_MAPPINGS.slice(startIndex, endIndex).map((mapping) => mapping.concept)
}

function brGroup(
  key: string,
  label: string,
  side: Exclude<FormalBalanceSide, null>,
  concepts: string[],
  subtotalKey?: TotalKey,
  subtotalConcept?: string,
): SequenceEntry[] {
  return [
    { kind: 'section', key, label, side },
    ...concepts.map((concept) => ({ kind: 'line' as const, concept, parent: key, side })),
    ...(subtotalKey && subtotalConcept
      ? [{
          kind: 'subtotal' as const,
          key: subtotalKey,
          concept: subtotalConcept,
          parent: key,
          side,
          label: `Summa ${label.toLocaleLowerCase('sv-SE')}`,
        }]
      : []),
  ]
}

const BR_SEQUENCE: SequenceEntry[] = [
  { kind: 'section', key: 'br-unpaid-capital', label: 'Tecknat ej inbetalt kapital', side: 'assets' },
  { kind: 'line', concept: 'TecknatEjInbetaltKapital', parent: 'br-unpaid-capital', side: 'assets' },
  ...brGroup(
    'br-intangible',
    'Immateriella anläggningstillgångar',
    'assets',
    conceptsBetween('KoncessionerPatentLicenserVarumarkenLiknandeRattigheter', 'ByggnaderMark'),
    'immateriellaAnlaggningstillgangar',
    'ImmateriellaAnlaggningstillgangar',
  ),
  ...brGroup(
    'br-tangible',
    'Materiella anläggningstillgångar',
    'assets',
    conceptsBetween('ByggnaderMark', 'AndelarKoncernforetag'),
    'materiellaAnlaggningstillgangar',
    'MateriellaAnlaggningstillgangar',
  ),
  ...brGroup(
    'br-financial-assets',
    'Finansiella anläggningstillgångar',
    'assets',
    conceptsBetween('AndelarKoncernforetag', 'LagerRavarorFornodenheter'),
    'finansiellaAnlaggningstillgangar',
    'FinansiellaAnlaggningstillgangar',
  ),
  {
    kind: 'subtotal',
    key: 'anlaggningstillgangar',
    concept: 'Anlaggningstillgangar',
    parent: null,
    side: 'assets',
    label: 'Summa anläggningstillgångar',
  },
  ...brGroup(
    'br-inventory',
    'Varulager m.m.',
    'assets',
    conceptsBetween('LagerRavarorFornodenheter', 'Kundfordringar'),
    'varulager',
    'VarulagerMm',
  ),
  ...brGroup(
    'br-receivables',
    'Kortfristiga fordringar',
    'assets',
    conceptsBetween('Kundfordringar', 'AndelarKoncernforetagKortfristiga'),
    'kortfristigaFordringar',
    'KortfristigaFordringar',
  ),
  ...brGroup(
    'br-short-investments',
    'Kortfristiga placeringar',
    'assets',
    conceptsBetween('AndelarKoncernforetagKortfristiga', 'KassaBankExklRedovisningsmedel'),
    'kortfristigaPlaceringar',
    'KortfristigaPlaceringar',
  ),
  ...brGroup(
    'br-cash',
    'Kassa och bank',
    'assets',
    conceptsBetween('KassaBankExklRedovisningsmedel', 'Aktiekapital'),
    'kassaBank',
    'KassaBank',
  ),
  {
    kind: 'subtotal',
    key: 'omsattningstillgangar',
    concept: 'Omsattningstillgangar',
    parent: null,
    side: 'assets',
    label: 'Summa omsättningstillgångar',
  },
  {
    kind: 'total',
    key: 'tillgangar',
    concept: 'Tillgangar',
    parent: null,
    side: 'assets',
    label: 'Summa tillgångar',
  },
  ...brGroup(
    'br-bound-equity',
    'Bundet eget kapital',
    'equity_liabilities',
    conceptsBetween('Aktiekapital', 'Overkursfond'),
    'bundetEgetKapital',
    'BundetEgetKapital',
  ),
  ...brGroup(
    'br-free-equity',
    'Fritt eget kapital',
    'equity_liabilities',
    conceptsBetween('Overkursfond', 'Periodiseringsfonder'),
    'frittEgetKapital',
    'FrittEgetKapital',
  ),
  {
    kind: 'subtotal',
    key: 'egetKapital',
    concept: 'EgetKapital',
    parent: null,
    side: 'equity_liabilities',
    label: 'Summa eget kapital',
  },
  ...brGroup(
    'br-untaxed-reserves',
    'Obeskattade reserver',
    'equity_liabilities',
    conceptsBetween('Periodiseringsfonder', 'AvsattningarPensionerLiknandeForpliktelserEnligtLag'),
    'obeskattadeReserver',
    'ObeskattadeReserver',
  ),
  ...brGroup(
    'br-provisions',
    'Avsättningar',
    'equity_liabilities',
    conceptsBetween('AvsattningarPensionerLiknandeForpliktelserEnligtLag', 'Obligationslan'),
    'avsattningar',
    'Avsattningar',
  ),
  ...brGroup(
    'br-long-liabilities',
    'Långfristiga skulder',
    'equity_liabilities',
    conceptsBetween('Obligationslan', 'ForskottFranKunder'),
    'langfristigaSkulder',
    'LangfristigaSkulder',
  ),
  ...brGroup(
    'br-short-liabilities',
    'Kortfristiga skulder',
    'equity_liabilities',
    conceptsBetween('ForskottFranKunder'),
    'kortfristigaSkulder',
    'KortfristigaSkulder',
  ),
  {
    kind: 'total',
    key: 'egetKapitalSkulder',
    concept: 'EgetKapitalSkulder',
    parent: null,
    side: 'equity_liabilities',
    label: 'Summa eget kapital och skulder',
  },
]

function taxonomyLabel(concept: string, fallback?: string): string {
  const registry = getRegistry(K2_AB_RISBS_2024_09_12.registryId)
  return fallback ?? getConcept(registry, concept)?.label ?? concept
}

function displayAmount(
  amount: number | null,
  signRule: K2FormalReportNode['signRule'],
): number | null {
  if (amount === null) return null
  return signRule === 'display_negative' ? -amount : amount
}

function createNodes(
  reportType: FormalReportType,
  sequence: SequenceEntry[],
  amounts: K2MappingResult['rr'] | K2MappingResult['br'],
  totals: K2MappingResult['totals'],
): K2FormalReportNode[] {
  let order = 0
  return sequence.map((entry) => {
    order += 10
    if (entry.kind === 'section') {
      return {
        key: entry.key,
        framework: 'k2',
        reportType,
        kind: 'section',
        label: entry.label,
        taxonomyConcept: null,
        parentKey: null,
        balanceSide: entry.side ?? null,
        order,
        signRule: 'natural',
        current: 0,
        previous: null,
        displayCurrent: 0,
        displayPrevious: null,
        required: true,
        visible: true,
      }
    }

    if (entry.kind === 'line') {
      const amount = amounts[entry.concept] ?? { current: 0, previous: null }
      const mapping =
        reportType === 'income_statement'
          ? K2_RR_MAPPINGS.find((candidate) => candidate.concept === entry.concept)
          : K2_BR_MAPPINGS.find((candidate) => candidate.concept === entry.concept)
      const signRule: K2FormalReportNode['signRule'] =
        reportType === 'income_statement' && mapping?.balance === 'debit'
          ? 'display_negative'
          : 'natural'
      const required = entry.required === true || entry.concept === 'AretsResultatEgetKapital'
      return {
        key: `${reportType}:${entry.concept}`,
        framework: 'k2',
        reportType,
        kind: 'line',
        label: taxonomyLabel(entry.concept, entry.label),
        taxonomyConcept: entry.concept,
        parentKey: entry.parent,
        balanceSide: entry.side ?? null,
        order,
        signRule,
        current: amount.current,
        previous: amount.previous,
        displayCurrent: displayAmount(amount.current, signRule) ?? 0,
        displayPrevious: displayAmount(amount.previous, signRule),
        required,
        visible: required || amount.current !== 0 || (amount.previous ?? 0) !== 0,
      }
    }

    const amount: ConceptAmount = totals[entry.key]
    const signRule = entry.signRule ?? 'natural'
    return {
      key: `${reportType}:total:${entry.key}`,
      framework: 'k2',
      reportType,
      kind: entry.kind,
      label: entry.label,
      taxonomyConcept: entry.concept,
      parentKey: entry.parent,
      balanceSide: entry.side ?? null,
      order,
      signRule,
      current: amount.current,
      previous: amount.previous,
      displayCurrent: displayAmount(amount.current, signRule) ?? 0,
      displayPrevious: displayAmount(amount.previous, signRule),
      required: true,
      visible: true,
    }
  })
}

export function buildK2FormalReportModel(
  current: TrialBalancePair,
  previous: TrialBalancePair | null,
): K2FormalReportModel {
  const mapping = mapTrialBalancesToK2(current, previous)
  const model: K2FormalReportModel = {
    modelVersion: 'k2-risbs-2024-09-12-v1',
    mappingVersion: K2_MAPPING_VERSION,
    framework: 'k2',
    taxonomyEntryPointId: K2_AB_RISBS_2024_09_12.id,
    taxonomyRegistryId: K2_AB_RISBS_2024_09_12.registryId,
    nodes: [
      ...createNodes('income_statement', RR_SEQUENCE, mapping.rr, mapping.totals),
      ...createNodes('balance_sheet', BR_SEQUENCE, mapping.br, mapping.totals),
    ],
    rr: mapping.rr,
    br: mapping.br,
    totals: mapping.totals,
    warnings: mapping.warnings,
    unmappedAccounts: mapping.unmappedAccounts,
  }
  assertK2FormalReportModel(model)
  return model
}

/**
 * Full row-level invariant. Every concept and every subtotal used by PDF and
 * iXBRL must be represented by exactly one canonical node with the same value.
 */
export function assertK2FormalReportModel(model: K2FormalReportModel): void {
  const seen = new Set<string>()
  for (const node of model.nodes) {
    if (seen.has(node.key)) throw new Error(`Duplicate formal-report node: ${node.key}`)
    seen.add(node.key)
    if (node.kind === 'section') continue

    const source = node.reportType === 'income_statement' ? model.rr : model.br
    if (node.kind === 'line') {
      if (!node.taxonomyConcept) throw new Error(`Formal line ${node.key} lacks taxonomy concept`)
      const expected = source[node.taxonomyConcept]
      if (!expected || expected.current !== node.current || expected.previous !== node.previous) {
        throw new Error(`Formal-report row drift for ${node.taxonomyConcept}`)
      }
      continue
    }

    const totalKey = node.key.split(':').at(-1) as TotalKey
    const expected = model.totals[totalKey]
    if (!expected || expected.current !== node.current || expected.previous !== node.previous) {
      throw new Error(`Formal-report total drift for ${totalKey}`)
    }
  }

  for (const mapping of K2_RR_MAPPINGS) {
    if (!seen.has(`income_statement:${mapping.concept}`)) {
      throw new Error(`K2 RR concept missing from formal model: ${mapping.concept}`)
    }
  }
  for (const mapping of K2_BR_MAPPINGS) {
    if (!seen.has(`balance_sheet:${mapping.concept}`)) {
      throw new Error(`K2 BR concept missing from formal model: ${mapping.concept}`)
    }
  }
}

export function formalIncomeStatementLines(model: K2FormalReportModel): IncomeStatementLine[] {
  assertK2FormalReportModel(model)
  return model.nodes
    .filter((node) => node.reportType === 'income_statement' && node.kind !== 'section' && node.visible)
    .map((node) => ({
      label: node.label,
      amount: node.displayCurrent,
      prior_amount: node.displayPrevious,
      is_total: node.kind === 'subtotal' || node.kind === 'total',
    }))
}

export function formalBalanceSheetLines(model: K2FormalReportModel): {
  assets: BalanceSheetLine[]
  total_assets: number
  equity_liabilities: BalanceSheetLine[]
  total_equity_liabilities: number
  total_assets_prior: number | null
  total_equity_liabilities_prior: number | null
} {
  assertK2FormalReportModel(model)
  const toLine = (node: K2FormalReportNode): BalanceSheetLine => ({
    label: node.label,
    amount: node.displayCurrent,
    prior_amount: node.displayPrevious,
    is_total: node.kind === 'subtotal' || node.kind === 'total',
    indent: node.kind === 'line' ? 1 : 0,
  })
  const rows = model.nodes.filter(
    (node) => node.reportType === 'balance_sheet' && node.kind !== 'section' && node.visible,
  )
  return {
    assets: rows.filter((node) => node.balanceSide === 'assets').map(toLine),
    total_assets: model.totals.tillgangar.current,
    equity_liabilities: rows
      .filter((node) => node.balanceSide === 'equity_liabilities')
      .map(toLine),
    total_equity_liabilities: model.totals.egetKapitalSkulder.current,
    total_assets_prior: model.totals.tillgangar.previous,
    total_equity_liabilities_prior: model.totals.egetKapitalSkulder.previous,
  }
}
