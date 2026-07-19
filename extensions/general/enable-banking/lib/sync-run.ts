import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * bank_sync_runs recorder — audit trail per sync attempt.
 *
 * Best-effort by design: a failure to write the audit row must never abort
 * the sync itself (the transactions matter more than the telemetry row).
 * Alongside the run row we keep bank_connections.sync_status /
 * consent_status up to date so status UIs and the platform integration
 * health view read one canonical field instead of re-deriving it.
 */

export type SyncTrigger = 'manual' | 'cron' | 'initial_backfill' | 'file_import'
export type SyncRunStatus = 'success' | 'partial' | 'failed' | 'auth_required' | 'rate_limited'

export async function startSyncRun(
  supabase: SupabaseClient,
  args: {
    companyId: string
    bankConnectionId: string | null
    trigger: SyncTrigger
    createdBy?: string | null
  },
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('bank_sync_runs')
      .insert({
        company_id: args.companyId,
        bank_connection_id: args.bankConnectionId,
        provider: 'enable_banking',
        trigger_source: args.trigger,
        status: 'running',
        created_by: args.createdBy ?? null,
      })
      .select('id')
      .single()
    return (data as { id: string } | null)?.id ?? null
  } catch {
    return null
  }
}

export async function finishSyncRun(
  supabase: SupabaseClient,
  syncRunId: string | null,
  args: {
    status: SyncRunStatus
    accountsSynced?: number
    transactionsImported?: number
    transactionsDeduplicated?: number
    errorMessage?: string | null
    details?: Record<string, unknown>
  },
): Promise<void> {
  if (!syncRunId) return
  try {
    await supabase
      .from('bank_sync_runs')
      .update({
        status: args.status,
        finished_at: new Date().toISOString(),
        accounts_synced: args.accountsSynced ?? 0,
        transactions_imported: args.transactionsImported ?? 0,
        transactions_deduplicated: args.transactionsDeduplicated ?? 0,
        error_message: args.errorMessage ?? null,
        details: args.details ?? {},
      })
      .eq('id', syncRunId)
  } catch {
    // Best-effort — never abort the sync over telemetry.
  }
}

/**
 * Keep bank_connections.sync_status/consent_status canonical. The columns
 * were added in 20260625120000 but never written — status UIs re-derived
 * state from `status` + `error_message`. Now every sync writes them.
 */
export async function updateConnectionSyncStatus(
  supabase: SupabaseClient,
  connectionId: string,
  args: {
    syncStatus: 'idle' | 'syncing' | 'success' | 'error'
    consentStatus?: 'active' | 'expired' | 'revoked' | 'consent_required'
    lastSyncError?: string | null
  },
): Promise<void> {
  try {
    await supabase
      .from('bank_connections')
      .update({
        sync_status: args.syncStatus,
        ...(args.consentStatus ? { consent_status: args.consentStatus } : {}),
        last_sync_error: args.lastSyncError ?? null,
      })
      .eq('id', connectionId)
  } catch {
    // Best-effort.
  }
}
