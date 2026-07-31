import { describe, expect, it, vi } from 'vitest'
import { buildK2EquityRollforward } from '../equity-rollforward'
import type { K2FormalReportModel } from '@/lib/bokslut/formal-report/k2-model'

function mockModel(): K2FormalReportModel {
  return {
    modelVersion: 'k2-risbs-2024-09-12-v1',
    mappingVersion: 'k2-bas-2026-v1',
    framework: 'k2',
    taxonomyEntryPointId: 'k2',
    taxonomyRegistryId: 'k2',
    nodes: [],
    rr: {},
    br: {
      Aktiekapital: { current: 25200, previous: 25200 },
      AretsResultatEgetKapital: { current: 17689.5, previous: -9386.58 },
    },
    totals: {
      egetKapital: { current: 29294.19, previous: 11604.69 },
    },
    warnings: [],
    unmappedAccounts: [],
  } as unknown as K2FormalReportModel
}

function supabaseWith(events: unknown[]) {
  const order = vi.fn().mockResolvedValue({ data: events, error: null })
  const eqPeriod = vi.fn().mockReturnValue({ order })
  const eqCompany = vi.fn().mockReturnValue({ eq: eqPeriod })
  const select = vi.fn().mockReturnValue({ eq: eqCompany })
  return { from: vi.fn().mockReturnValue({ select }) } as never
}

describe('K2 equity roll-forward', () => {
  it('shows opening, prior-result transfer, current result and closing columns', async () => {
    const result = await buildK2EquityRollforward(
      supabaseWith([{ event_type: 'prior_year_result_transfer', amount: 9386.58 }]),
      'company',
      'period',
      mockModel(),
    )
    expect(result.rows.map((entry) => entry.label)).toEqual([
      'Ingående balans',
      'Omföring av föregående års resultat',
      'Årets resultat',
      'Utgående balans',
    ])
    expect(result.rows.at(-1)).toMatchObject({
      aktiekapital: 25200,
      balanserat_resultat: -13595.31,
      arets_resultat: 17689.5,
    })
  })

  it('never guesses that an unexplained residual is a dividend', async () => {
    const model = mockModel()
    model.totals.egetKapital.current -= 1000
    const result = await buildK2EquityRollforward(
      supabaseWith([{ event_type: 'prior_year_result_transfer', amount: 9386.58 }]),
      'company',
      'period',
      model,
    )
    expect(result.rows.some((entry) => /utdelning/i.test(entry.label))).toBe(false)
    expect(result.rows.some((entry) => /manuell granskning/i.test(entry.label))).toBe(true)
    expect(result.reconciled).toBe(false)
  })
})
