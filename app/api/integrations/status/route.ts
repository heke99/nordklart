import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { getPeppolReadiness } from '@/lib/peppol/provider'
import { getFinancingReadiness } from '@/lib/invoice-financing/provider'

/**
 * GET /api/integrations/status — company-scoped integration overview.
 *
 * One aggregate for the /settings/integrations section and the /automation
 * hub: bank connection health, Skatteverket connection, Bankgiro
 * application, Peppol/financing readiness, BankID consents, API keys and
 * webhooks. Read-only; each block links to its own management surface.
 */
export const GET = withRouteContext(
  'integrations.status',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    try {
      const [
        { data: bankConnections },
        { data: latestSync },
        { data: skv },
        { data: bankgiro },
        { count: eInvoiceCount },
        { count: consentCount },
        { count: apiKeyCount },
        { count: webhookCount },
        { count: failedWebhookDeliveries },
      ] = await Promise.all([
        supabase
          .from('bank_connections')
          .select('id, bank_name, status, consent_status, sync_status, last_synced_at, consent_expires')
          .eq('company_id', companyId)
          .order('created_at', { ascending: false }),
        supabase
          .from('bank_sync_runs')
          .select('started_at, status, trigger_source')
          .eq('company_id', companyId)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('skatteverket_company_settings')
          .select('connection_status, token_status, oauth_connected_at')
          .eq('company_id', companyId)
          .maybeSingle(),
        supabase
          .from('bankgiro_applications')
          .select('status, provider_setup_status, updated_at')
          .eq('company_id', companyId)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('e_invoice_deliveries')
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId),
        supabase
          .from('signed_consents')
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('status', 'active'),
        // api_keys are user-scoped (no company_id column).
        supabase
          .from('api_keys')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', ctx.user.id)
          .is('revoked_at', null),
        supabase
          .from('webhooks')
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('active', true),
        supabase
          .from('webhook_deliveries')
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .in('status', ['failed', 'dead']),
      ])

      return NextResponse.json({
        data: {
          bank: {
            connections: bankConnections ?? [],
            latest_sync: latestSync ?? null,
          },
          skatteverket: {
            connection_status: (skv as { connection_status?: string } | null)?.connection_status ?? 'not_connected',
            token_status: (skv as { token_status?: string } | null)?.token_status ?? 'missing',
          },
          bankgiro: bankgiro ?? null,
          peppol: {
            readiness: getPeppolReadiness(),
            delivery_count: eInvoiceCount ?? 0,
          },
          invoice_financing: { readiness: getFinancingReadiness() },
          bankid: { active_consents: consentCount ?? 0 },
          api: { active_keys: apiKeyCount ?? 0 },
          webhooks: {
            active: webhookCount ?? 0,
            failed_deliveries: failedWebhookDeliveries ?? 0,
          },
        },
      })
    } catch (err) {
      log.error('integrations status failed', err as Error)
      return errorResponse(err, log, { requestId })
    }
  },
)
