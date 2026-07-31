import { describe, expect, it } from 'vitest'
import { runAnnualReportPreflight } from '../preflight'
import type { ArsredovisningData } from '../types'

function validData(): ArsredovisningData {
  return {
    company: { name: 'Gridex EL AB', org_number: '559416-7149', city: 'Linköping' },
    fiscal_period: {
      id: 'period',
      name: '2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    },
    accounting_framework: 'k2',
    formal_report: {
      totals: {
        resultatEfterFinansiellaPoster: { current: 19843.5, previous: 0 },
      },
    } as ArsredovisningData['formal_report'],
    forvaltningsberattelse: {
      description: 'Bolaget utvecklar och säljer energitjänster.',
      important_events: 'Inga väsentliga händelser.',
      events_after_balance_sheet: 'Bolaget ändrade företagsnamn under 2026.',
      kontrollbalans_required: false,
      flerarsoversikt: [
        { year: '2025', net_revenue: 21300, result_after_financial: 19844, soliditet_pct: 116.5 },
      ],
      egen_kapital_changes: [
        { label: 'Ingående balans', amount: 11604.69, row_kind: 'opening' },
        { label: 'Utgående balans', amount: 29294.19, row_kind: 'closing' },
      ],
      resultatdisposition: '4 094,19 kr balanseras i ny räkning.',
      agm_date: '2026-05-20',
      agm_accounts_adopted: true,
      agm_result_disposition_decision: 'Resultatet disponeras enligt styrelsens förslag.',
      certificate_signer_name: 'Anna Andersson',
      certificate_signer_role: 'Styrelseledamot',
      certificate_signed_at: '2026-05-20',
    },
    resultatrakning: [],
    balansrakning: {
      assets: [],
      total_assets: 25149.5,
      equity_liabilities: [],
      total_equity_liabilities: 25149.5,
    },
    noter: [],
    signatures: [
      {
        role: 'Styrelseledamot',
        name: 'Anna Andersson',
        signed_at: '2026-04-30T10:00:00Z',
        status: 'signed',
      },
    ],
    prior_period: null,
    unconfirmed_defaults: [],
    warnings: [],
    disclosures: {
      long_term_debt_over_five_years: null,
      securities_pledged: null,
      contingent_liabilities: null,
      parent_company_name: null,
      parent_company_org_number: null,
      parent_company_city: null,
    },
  }
}

describe('annual-report preflight', () => {
  it('allows document data on a locked ledger and reports only the >100% solidity warning', () => {
    const report = runAnnualReportPreflight(validData(), {
      ledger_locked: true,
      period_closed: true,
      closing_entry_id: 'entry',
      pdf_ixbrl_match: true,
      final_pdf_requested: true,
      pdf_text_contains_draft: false,
    })
    expect(report.preflight_status).toBe('passed')
    expect(report.issues.map((entry) => entry.code)).toContain('SOLIDITY_OVER_100')
  })


  it('blocks missing document-only legal identity fields without requiring a ledger reopen', () => {
    const data = validData()
    data.company.name = 'Bolaget'
    data.company.city = null
    const report = runAnnualReportPreflight(data, {
      ledger_locked: true,
      period_closed: true,
      closing_entry_id: 'entry',
    })
    expect(report.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['LEGAL_NAME_MISSING', 'REGISTERED_OFFICE_MISSING']),
    )
    expect(
      report.issues
        .filter((entry) => ['LEGAL_NAME_MISSING', 'REGISTERED_OFFICE_MISSING'].includes(entry.code))
        .every((entry) => entry.requires_reopen === false),
    ).toBe(true)
  })

  it('blocks finalization when AGM decision and signatures are missing', () => {
    const data = validData()
    data.forvaltningsberattelse.agm_result_disposition_decision = null
    data.signatures = []
    const report = runAnnualReportPreflight(data, {
      ledger_locked: true,
      period_closed: true,
      closing_entry_id: 'entry',
    })
    expect(report.preflight_status).toBe('failed')
    expect(report.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['AGM_RESULT_DECISION_MISSING', 'SIGNATURES_INCOMPLETE']),
    )
  })
})
