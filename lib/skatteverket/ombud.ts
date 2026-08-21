import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'

const log = createLogger('skatteverket.ombud')

export type SkvOmbudAuthFlow = 'per_bankid' | 'ccg_sysorg' | 'org_acg'

export interface SkvOmbudObservation {
  companyId: string
  authFlow: SkvOmbudAuthFlow
  /**
   * What Skatteverket's answer says about authorisation. Only pass a verdict
   * when the response actually carries one — see `verdictFromResponse`.
   */
  authorized: boolean
  correlationId?: string | null
  statusCode?: number | null
  skvErrorCode?: string | null
  operation?: string | null
}

/**
 * Records what Skatteverket answered about a company's ombud/firmatecknare
 * authorisation, into `skatteverket_ombud_authorizations`.
 *
 * There is no API that answers "is this actor authorised for this company?"
 * (SKV-02) — but every call carries the answer implicitly: a 403 naming
 * behörighet is a no, and a call that succeeds for the company is a yes. Those
 * are the only two facts the system can honestly hold, so they are the only two
 * this records. Anything else — a 500, a validation failure, a network blip —
 * says nothing about authorisation and is deliberately not written.
 *
 * Best-effort throughout: a filing must never fail because its authorisation
 * bookkeeping did. Failures are logged.
 *
 * Service role is required because `record_skv_ombud_observation` is
 * `REVOKE ALL … FROM authenticated` — the whole point of the model is that a
 * user session cannot assert its own authorisation. This function's entire
 * privileged surface is one org-number lookup and that one RPC; see
 * docs/audits/2026-08-21-service-role-additions.md.
 */
export async function recordSkvOmbudObservation(obs: SkvOmbudObservation): Promise<void> {
  if (!obs.companyId) return

  try {
    const supabase = createServiceClient()

    // The org number is a property of the company, so it does not have to be
    // threaded through every SKV client call to get here.
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('org_number')
      .eq('id', obs.companyId)
      .maybeSingle()

    if (companyError || !company?.org_number) {
      log.warn('ombud observation skipped — no org number for company', {
        companyId: obs.companyId,
        error: companyError?.message,
      })
      return
    }

    const { error } = await supabase.rpc('record_skv_ombud_observation', {
      p_company_id: obs.companyId,
      p_org_number: company.org_number,
      p_auth_flow: obs.authFlow,
      p_observation: {
        kind: 'skv_response',
        authorized: obs.authorized,
        correlation_id: obs.correlationId ?? null,
        status_code: obs.statusCode ?? null,
        skv_error_code: obs.skvErrorCode ?? null,
        operation: obs.operation ?? null,
      },
    })

    if (error) {
      log.warn('record_skv_ombud_observation failed (non-blocking)', {
        companyId: obs.companyId,
        authFlow: obs.authFlow,
        message: error.message,
        code: error.code,
      })
    }
  } catch (err) {
    log.warn('ombud observation threw (non-blocking)', {
      companyId: obs.companyId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Decides whether an HTTP outcome carries an authorisation verdict at all.
 *
 * `null` means "this response says nothing about authorisation" — which is the
 * common case, and the one where writing a row would be a lie.
 */
export function verdictFromResponse(
  statusCode: number,
  bodyOrMessage: string | null | undefined,
): boolean | null {
  if (statusCode >= 200 && statusCode < 300) return true
  if (statusCode === 403 && /behörighet|behorighet/i.test(bodyOrMessage ?? '')) return false
  return null
}
