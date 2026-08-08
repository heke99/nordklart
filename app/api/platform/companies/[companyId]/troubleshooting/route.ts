import { NextResponse } from 'next/server'
import { z } from 'zod'
import { PLATFORM_ROLES } from '@/lib/auth/platform'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import { computeIntegrationReadiness } from '@/lib/platform/integration-readiness'

const log = createLogger('platform-troubleshooting-export')

/**
 * GET /api/platform/companies/[companyId]/troubleshooting
 *
 * Support tooling: technical troubleshooting report for one company as
 * downloadable JSON. Read-only, no RLS bypass beyond what platform support
 * legitimately needs, and every export is written to audit_log (who exported
 * what, when) — support access must always leave a trail.
 *
 * The report deliberately contains NO bookkeeping amounts, personal numbers
 * or document contents — only operational metadata (statuses, counts,
 * timestamps, error codes).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ companyId: string }> },
) {
  // Inline platform-role check (requirePlatformRole redirect()s — wrong
  // semantics for an API route; we want a clean 401/403 JSON). requireAuth
  // enforces MFA AAL2 on hosted before we even look at the role.
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { data: platformRole } = await auth.supabase
    .from('platform_roles')
    .select('role')
    .eq('user_id', auth.user.id)
    .in('role', [...PLATFORM_ROLES])
    // A revoked grant is not a role. Without this predicate the export stayed
    // available to anyone who had ever held platform access — revocation is
    // recorded, not deleted (`revoked_at`), so the row survives the revoke.
    .is('revoked_at', null)
    .limit(1)
    .maybeSingle()
  if (!platformRole) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const platformUserId = auth.user.id

  const { companyId } = await params
  if (!z.string().uuid().safeParse(companyId).success) {
    return NextResponse.json({ error: 'Ogiltigt företags-id.' }, { status: 400 })
  }

  const db = createServiceClient()

  const { data: company } = await db
    .from('companies')
    .select('id, name, org_number, entity_type, created_at, archived_at')
    .eq('id', companyId)
    .maybeSingle()

  if (!company) {
    return NextResponse.json({ error: 'Företaget kunde inte hittas.' }, { status: 404 })
  }

  const [
    { data: operationalStatus },
    { data: bankConnections },
    { data: syncRuns },
    { data: skv },
    { data: taxSubmissions },
    { data: bankgiro },
    { data: failedOperations },
    { data: failedWebhookDeliveries },
    { data: recentEvents },
    { count: memberCount },
  ] = await Promise.all([
    db.from('platform_company_operational_status_v').select('*').eq('company_id', companyId).maybeSingle(),
    db.from('bank_connections').select('id, bank_name, status, consent_status, sync_status, last_synced_at, consent_expires, error_message').eq('company_id', companyId),
    db.from('bank_sync_runs').select('id, trigger_source, status, started_at, finished_at, transactions_imported, error_message').eq('company_id', companyId).order('started_at', { ascending: false }).limit(10),
    db.from('skatteverket_company_settings').select('connection_status, token_status, oauth_connected_at, last_token_check_at').eq('company_id', companyId).maybeSingle(),
    db.from('tax_submissions').select('submission_type, period_key, status, updated_at').eq('company_id', companyId).order('updated_at', { ascending: false }).limit(10),
    db.from('bankgiro_applications').select('status, provider_setup_status, documents_status, updated_at').eq('company_id', companyId).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('operations').select('id, operation_type, status, error, created_at').eq('company_id', companyId).eq('status', 'failed').order('created_at', { ascending: false }).limit(10),
    db.from('webhook_deliveries').select('id, event_type, status, attempts, last_error, created_at').eq('company_id', companyId).in('status', ['failed', 'dead']).order('created_at', { ascending: false }).limit(10),
    db.from('event_log').select('event_type, created_at').eq('company_id', companyId).order('created_at', { ascending: false }).limit(20),
    db.from('company_members').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
  ])

  const report = {
    generated_at: new Date().toISOString(),
    generated_by: platformUserId,
    company: {
      id: company.id,
      name: company.name,
      org_number: company.org_number,
      entity_type: company.entity_type,
      created_at: company.created_at,
      archived_at: company.archived_at,
      member_count: memberCount ?? 0,
    },
    operational_status: operationalStatus ?? null,
    integrations: {
      deployment_readiness: computeIntegrationReadiness().map((e) => ({ id: e.id, status: e.status })),
      bank_connections: bankConnections ?? [],
      recent_sync_runs: syncRuns ?? [],
      skatteverket: skv ?? null,
      bankgiro: bankgiro ?? null,
      tax_submissions: taxSubmissions ?? [],
    },
    failures: {
      failed_operations: failedOperations ?? [],
      failed_webhook_deliveries: failedWebhookDeliveries ?? [],
    },
    recent_events: recentEvents ?? [],
  }

  // Audit the export — support access must leave a trail.
  const { error: auditErr } = await db.from('audit_log').insert({
    user_id: platformUserId,
    company_id: companyId,
    action: 'SECURITY_EVENT',
    table_name: 'companies',
    record_id: companyId,
    actor_id: platformUserId,
    description: 'Plattformssupport exporterade teknisk felsökningsrapport (troubleshooting export).',
    new_state: { kind: 'troubleshooting_export' },
  })
  if (auditErr) {
    // Refuse to hand out the report if the audit trail cannot be written.
    log.error('troubleshooting export audit write failed', auditErr, { companyId })
    return NextResponse.json({ error: 'Exporten kunde inte granskningsloggas — avbruten.' }, { status: 500 })
  }

  log.info('troubleshooting export generated', { companyId, by: platformUserId })

  return new NextResponse(JSON.stringify(report, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="nordklart-felsokning-${companyId.slice(0, 8)}.json"`,
    },
  })
}
