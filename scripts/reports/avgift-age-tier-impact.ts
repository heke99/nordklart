#!/usr/bin/env npx tsx
/**
 * Report salary already calculated with the wrong arbetsgivaravgift age tier.
 *
 * Corrected 2026-09-25 (commit 98be300):
 *  - 2025: the reduced avgift (10,21 %) applies from 66 at the start of the
 *    year (born 1938–1958); the config said 67, so employees born 1958 were
 *    charged 31,42 % on 2025 pay.
 *  - "vid årets ingång" is counted by birth year (Skatteverket), so employees
 *    born on 1 January could land in the wrong tier (youth rate 2026 for born
 *    2003/2008, reduced avgift for born 1959).
 *
 * READ-ONLY. Lists every affected salary_run_employees row in runs from 2025
 * on that are approved/paid/booked/corrected, with the stored and correct
 * avgift and the difference, per company and AGI period. Use it to file
 * rättelse of the AGI (arbetsgivardeklaration på individnivå) and, for booked
 * runs, a correction voucher through the salary correction flow.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the
 * personnummer encryption key in .env.local.
 *
 * Usage:
 *   npx tsx scripts/reports/avgift-age-tier-impact.ts            # table
 *   npx tsx scripts/reports/avgift-age-tier-impact.ts --csv      # CSV
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { loadPayrollConfig, type PayrollConfig } from '@/lib/salary/payroll-config'
import { assessAvgiftTierImpact } from '@/lib/salary/avgift-tier-impact'
import { roundOre } from '@/lib/money'

const CSV = process.argv.includes('--csv')
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
const supabase = createClient(url, key)

interface Row {
  id: string
  company_id: string
  avgifter_category: string | null
  avgifter_rate: number
  avgifter_amount: number
  avgifter_basis: number
  avgifter_amount_override: number | null
  salary_runs: { id: string; period_year: number; period_month: number; payment_date: string; status: string }
  employees: {
    id: string
    first_name: string
    last_name: string
    personnummer: string
    personnummer_last4: string
    vaxa_stod_eligible: boolean
    vaxa_stod_start: string | null
    vaxa_stod_end: string | null
  }
}

async function main() {
  const configs = new Map<number, PayrollConfig>()
  const out: string[] = []
  let total = 0
  const pageSize = 500
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('salary_run_employees')
      .select(
        'id, company_id, avgifter_category, avgifter_rate, avgifter_amount, avgifter_basis, avgifter_amount_override, ' +
          'salary_runs!inner(id, period_year, period_month, payment_date, status), ' +
          'employees!inner(id, first_name, last_name, personnummer, personnummer_last4, vaxa_stod_eligible, vaxa_stod_start, vaxa_stod_end)',
      )
      .gte('salary_runs.payment_date', '2025-01-01')
      .in('salary_runs.status', ['approved', 'paid', 'booked', 'corrected'])
      .order('id')
      .range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as unknown as Row[]
    for (const row of rows) {
      const year = Number(row.salary_runs.payment_date.slice(0, 4))
      if (!configs.has(year)) configs.set(year, await loadPayrollConfig(supabase, year))
      const impact = assessAvgiftTierImpact(
        {
          paymentDate: row.salary_runs.payment_date,
          encryptedPersonnummer: row.employees.personnummer,
          vaxaStodEligible: row.employees.vaxa_stod_eligible,
          vaxaStodStart: row.employees.vaxa_stod_start,
          vaxaStodEnd: row.employees.vaxa_stod_end,
          storedCategory: row.avgifter_category,
          storedRate: Number(row.avgifter_rate),
          storedAmount: Number(row.avgifter_amount),
          basis: Number(row.avgifter_basis),
          hasOverride: row.avgifter_amount_override !== null,
        },
        configs.get(year)!,
      )
      if (!impact) continue
      total = roundOre(total + impact.difference)
      const period = `${row.salary_runs.period_year}-${String(row.salary_runs.period_month).padStart(2, '0')}`
      out.push([
        row.company_id, row.salary_runs.id, row.salary_runs.status, period, row.salary_runs.payment_date,
        row.employees.id, `${row.employees.first_name} ${row.employees.last_name}`, `XXXX${row.employees.personnummer_last4}`,
        impact.storedCategory ?? '', impact.correctCategory, impact.storedAmount.toFixed(2),
        impact.correctAmount.toFixed(2), impact.difference.toFixed(2),
      ].join(CSV ? ',' : ' | '))
    }
    if (rows.length < pageSize) break
  }

  const header = ['company_id', 'salary_run_id', 'status', 'agi_period', 'payment_date', 'employee_id', 'name', 'pnr', 'stored_category', 'correct_category', 'stored_avgift', 'correct_avgift', 'difference']
  console.log(header.join(CSV ? ',' : ' | '))
  for (const line of out) console.log(line)
  if (!CSV) {
    console.log(`\n${out.length} rad(er) påverkas. Summa differens: ${total.toFixed(2)} kr (positiv = för lite redovisat och betalt).`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
