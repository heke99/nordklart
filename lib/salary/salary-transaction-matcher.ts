import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('salary-transaction-matcher')

/**
 * Auto-match salary payment bank transactions to salary journal entries.
 *
 * When bank transactions arrive (via Enable Banking sync or CSV import),
 * this matcher looks for transactions that correspond to salary net payments:
 *   - Transaction date matches salary run payment_date
 *   - Transaction amount matches -total_net (negative = outgoing payment)
 *   - Transaction is not already categorized
 *
 * On match, links the transaction to the salary journal entry via
 * the existing reconciliation system.
 *
 * Per BFL 5 kap: Bank statement reconciliation is required.
 * Per BFNAR 2013:2: Automated matching must be logged.
 */
export async function matchSalaryTransactions(
  supabase: SupabaseClient,
  companyId: string,
  transactionIds: string[]
): Promise<{ matched: number }> {
  if (transactionIds.length === 0) return { matched: 0 }

  // Load unmatched transactions
  const { data: transactions, error: txError } = await supabase
    .from('transactions')
    .select('id, date, amount, description')
    .eq('company_id', companyId)
    .in('id', transactionIds)
    .is('journal_entry_id', null)
    .lt('amount', 0) // Only outgoing payments

  if (txError || !transactions || transactions.length === 0) return { matched: 0 }

  // Load booked salary runs for matching
  const { data: salaryRuns, error: srError } = await supabase
    .from('salary_runs')
    .select('id, payment_date, total_net, salary_entry_id, status')
    .eq('company_id', companyId)
    .eq('status', 'booked')

  if (srError || !salaryRuns || salaryRuns.length === 0) return { matched: 0 }

  let matched = 0

  for (const tx of transactions) {
    // Look for salary run where:
    // - payment_date matches transaction date
    // - total_net matches |transaction.amount| (within 1 SEK tolerance for öresavrundning)
    const txAmount = Math.abs(tx.amount)

    const matchingRun = salaryRuns.find(run => {
      if (run.payment_date !== tx.date) return false
      const diff = Math.abs(run.total_net - txAmount)
      return diff <= 1 // 1 SEK tolerance for rounding
    })

    if (matchingRun && matchingRun.salary_entry_id) {
      // Link transaction to the salary journal entry
      const { error: linkError } = await supabase
        .from('transactions')
        .update({
          journal_entry_id: matchingRun.salary_entry_id,
          is_business: true,
          category: 'salary',
        })
        .eq('id', tx.id)
        .is('journal_entry_id', null) // CAS guard

      if (!linkError) {
        matched++
        log.info(`Matched salary transaction ${tx.id} to run ${matchingRun.id} (${txAmount} SEK)`)

        // Log the match in payment_match_log for audit trail
        await supabase.from('payment_match_log').insert({
          company_id: companyId,
          transaction_id: tx.id,
          match_type: 'salary_payment',
          matched_entity_id: matchingRun.id,
          matched_entity_type: 'salary_run',
          amount: txAmount,
          auto_matched: true,
        })
      }
    }
  }

  if (matched > 0) {
    log.info(`Auto-matched ${matched} salary transaction(s) for company ${companyId}`)
  }

  return { matched }
}
