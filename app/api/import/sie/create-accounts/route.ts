import { NextResponse } from 'next/server'
import type { SIEAccount } from '@/lib/import/types'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * Determine account type based on account class (first digit)
 */
function getAccountType(accountNumber: string): 'asset' | 'equity' | 'liability' | 'revenue' | 'expense' {
  const firstDigit = parseInt(accountNumber.charAt(0), 10)

  switch (firstDigit) {
    case 1:
      return 'asset'
    case 2:
      // 20xx-20xx is equity, 21xx-29xx is liability
      const group = parseInt(accountNumber.substring(0, 2), 10)
      return group <= 20 ? 'equity' : 'liability'
    case 3:
      return 'revenue'
    case 4:
    case 5:
    case 6:
    case 7:
      return 'expense'
    case 8:
      // 8xxx can be either revenue (83xx interest income) or expense
      const subGroup = parseInt(accountNumber.substring(0, 2), 10)
      return subGroup >= 83 && subGroup <= 84 ? 'revenue' : 'expense'
    default:
      return 'expense'
  }
}

/**
 * Determine normal balance based on account type
 */
function getNormalBalance(accountType: string): 'debit' | 'credit' {
  switch (accountType) {
    case 'asset':
    case 'expense':
      return 'debit'
    case 'equity':
    case 'liability':
    case 'revenue':
      return 'credit'
    default:
      return 'debit'
  }
}

/**
 * POST /api/import/sie/create-accounts
 * Create missing accounts from SIE file definitions
 */
export const POST = withRouteContext(
  'sie_import.create_accounts',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx
    try {
      const body = await request.json()
      const accounts: SIEAccount[] = body.accounts

      if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
        return errorResponseFromCode('VALIDATION_FAILED', log, {
          requestId,
          details: { reason: 'Inga konton att skapa.' },
        })
      }

      const accountsToUpsert = accounts.map((account) => {
        const accountClass = parseInt(account.number.charAt(0), 10) || 1
        const accountGroup = account.number.substring(0, 2)
        const accountType = getAccountType(account.number)
        const normalBalance = getNormalBalance(accountType)
        return {
          user_id: user.id,
          company_id: companyId,
          account_number: account.number,
          account_name: account.name,
          account_class: accountClass,
          account_group: accountGroup,
          account_type: accountType,
          normal_balance: normalBalance,
          plan_type: 'full_bas',
          is_active: true,
          is_system_account: false,
          sort_order: parseInt(account.number, 10) || 0,
        }
      })

      const batchSize = 100
      let totalCreated = 0
      for (let i = 0; i < accountsToUpsert.length; i += batchSize) {
        const batch = accountsToUpsert.slice(i, i + batchSize)
        const { data: upserted, error } = await supabase
          .from('chart_of_accounts')
          .upsert(batch, {
            onConflict: 'company_id,account_number',
            ignoreDuplicates: true,
            count: 'exact',
          })
          .select('account_number')

        if (error) {
          return errorResponseFromCode('DATABASE_QUERY_FAILED', log, {
            requestId,
            reason: error.message,
            details: { operation: 'create_sie_accounts', created: totalCreated },
          })
        }
        totalCreated += upserted?.length ?? 0
      }

      return NextResponse.json({ success: true, created: totalCreated })
    } catch (error) {
      return errorResponseFromCode('SIE_IMPORT_ACCOUNT_ACTIVATION_FAILED', log, {
        requestId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  },
  { requireWrite: true, accessPolicy: 'sie_import' },
)
