/**
 * Single wrapper that gives every API route the same shape:
 *
 *   - generates a request id (`req_<uuid>`) and threads it through the logger
 *   - resolves auth via requireAuth() and (by default) the active companyId
 *   - emits one structured `info` log on completion with duration
 *   - converts any thrown value into the canonical error envelope via
 *     errorResponse(); the request id appears in the response body and the
 *     X-Request-Id response header. Unhandled errors are logged ("op failed")
 *     with the resolved { requestId, operation, userId, companyId } context.
 *
 * Usage:
 *   export const POST = withRouteContext('invoice.send', async (req, ctx) => {
 *     // ctx.requestId, ctx.log, ctx.user, ctx.supabase, ctx.companyId
 *     const result = await sendInvoice(...)
 *     return NextResponse.json({ data: result })
 *   })
 *
 * For dynamic routes the second parameter is the Next.js params promise:
 *   export const POST = withRouteContext('invoice.send', async (req, ctx, { params }) => {
 *     const { id } = await params
 *     ...
 *   })
 */

import type { SupabaseClient, User } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import {
  auditPlatformSieImportOperation,
  resolveSieImportAccess,
  type SieImportAccessDecision,
} from '@/lib/import/access'
import { requireWritePermission } from '@/lib/auth/require-write'
import { getActiveCompanyId } from '@/lib/company/context'
import { createLogger, type Logger } from '@/lib/logger'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { featureForOperation } from '@/lib/platform/feature-policy'
import { checkFeatureAccess, featureAccessError } from '@/lib/platform/entitlements'
import { maintenanceBlocksWrites, getMaintenanceMessage } from '@/lib/ops/maintenance'

export interface RouteContext {
  /** Stable id for this HTTP request — appears in logs, error envelope, X-Request-Id header. */
  requestId: string
  /** Logger pre-bound with { requestId, userId, companyId, operation }. */
  log: Logger
  /** Authenticated user. Always present — wrapper short-circuits with 401 otherwise. */
  user: User
  /** Authenticated Supabase client (request-scoped, RLS active). */
  supabase: SupabaseClient
  /** Present for SIE routes after canonical bookkeeping/year-end access resolution. */
  sieImportAccess?: SieImportAccessDecision
  /**
   * Resolved active company id. The wrapper short-circuits with
   * COMPANY_CONTEXT_MISSING before invoking the handler when no company is
   * resolved, so handlers can treat this as guaranteed non-null. Routes that
   * need to opt out of the guarantee (e.g. onboarding) shouldn't use
   * withRouteContext.
   *
   * Access invariant: `getActiveCompanyId` only returns a company the
   * authenticated user can currently read (validated centrally via
   * `resolve_company_access`, which covers direct members, authorized
   * agency staff and platform admins, and excludes archived companies). The handler may
   * therefore treat `companyId` as "a company the caller is authorized to
   * read", and routes that mutate state additionally enforce a non-viewer
   * role via `requireWrite: true`. ASVS V8.2.1 / SOC 2 CC6.3.
   */
  companyId: string
}

interface RouteContextOptions {
  /** Use the combined bookkeeping/year-end/one-off policy and a narrowly scoped service client. */
  accessPolicy?: 'default' | 'sie_import'
  /** Accept ?company_id= only after canonical server-side actor/company verification. */
  allowRequestedCompany?: boolean

  /**
   * Defaults to false. When true, the wrapper rejects callers whose role in
   * the active company is `viewer` (or who have no membership). Mirrors the
   * existing requireWritePermission() helper so mutating routes can drop two
   * lines of boilerplate.
   */
  requireWrite?: boolean
}

// Next.js 16 always passes a `{ params: Promise<...> }` second arg to route
// handlers — including on non-dynamic routes, where it's `Promise<{}>`. The
// generic defaults to that empty shape so static routes type-check without
// having to declare any params at the call site.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type DynamicParams = { params: Promise<Record<string, string | string[]>> } | { params: Promise<{}> }

type RouteHandler<P extends DynamicParams = { params: Promise<Record<string, never>> }> = (
  request: Request,
  ctx: RouteContext,
  params: P,
) => Promise<NextResponse | Response>

function generateRequestId(): string {
  // crypto.randomUUID is available in Node 20+/edge runtimes used by Next.js.
  return `req_${crypto.randomUUID()}`
}

export function withRouteContext<P extends DynamicParams = { params: Promise<Record<string, never>> }>(
  operation: string,
  handler: RouteHandler<P>,
  options: RouteContextOptions = {},
): (request: Request, params: P) => Promise<Response> {
  const { requireWrite = false, accessPolicy = 'default', allowRequestedCompany = false } = options

  return async function wrapped(request: Request, params: P): Promise<Response> {
    const requestId = generateRequestId()
    const start = Date.now()
    const log = createLogger(`api/${operation}`, { requestId, operation })
    // Upgraded as request context resolves, so an unhandled throw in the catch
    // below is logged with the richest available { userId, companyId } context
    // (audit trail / OWASP V16), not just { requestId, operation }.
    let errLog = log

    try {
      const auth = await requireAuth()
      if (auth.error) {
        log.warn('auth failed', { status: auth.error.status })
        // Pass through requireAuth's response unchanged for backwards-compat
        // with existing route tests; only inject the request id header so
        // support can still trace the request.
        if (!auth.error.headers.get('X-Request-Id')) {
          auth.error.headers.set('X-Request-Id', requestId)
        }
        return auth.error
      }

      const { user, supabase } = auth
      const userLog = log.child({ userId: user.id })
      errLog = userLog

      let companyId: string | null = null
      let requestedCompanyCanWrite: boolean | null = null
      const requestedCompanyId = allowRequestedCompany
        ? new URL(request.url).searchParams.get('company_id')
        : null

      if (requestedCompanyId) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedCompanyId)) {
          return errorResponseFromCode('INVALID_COMPANY_ID', userLog, { requestId })
        }
        const accessDb = createServiceClient()
        const { data: accessData, error: accessError } = await accessDb.rpc(
          'resolve_company_access_for_user',
          { p_user_id: user.id, p_company_id: requestedCompanyId },
        )
        if (accessError) {
          return errorResponseFromCode('DATABASE_QUERY_FAILED', userLog, {
            requestId,
            reason: accessError.message,
            details: { operation: 'resolve_requested_company_access' },
          })
        }
        const access = Array.isArray(accessData) ? accessData[0] : null
        if (!access?.can_read) return errorResponseFromCode('PERMISSION_DENIED', userLog, { requestId })
        companyId = requestedCompanyId
        requestedCompanyCanWrite = Boolean(access.can_write || access.can_manage_platform)
      } else {
        try {
          companyId = await getActiveCompanyId(supabase, user.id)
        } catch (err) {
          userLog.error('failed to resolve active company', err as Error)
        }
      }

      if (!companyId) {
        return errorResponseFromCode('COMPANY_CONTEXT_MISSING', userLog, { requestId })
      }

      let routeSupabase: SupabaseClient = supabase
      let sieImportAccess: SieImportAccessDecision | undefined

      if (accessPolicy === 'sie_import') {
        const serviceDb = createServiceClient()
        sieImportAccess = await resolveSieImportAccess(serviceDb, user.id, companyId)
        if (!sieImportAccess.allowed) {
          const code = sieImportAccess.reason === 'permission_denied'
            ? 'PERMISSION_DENIED'
            : sieImportAccess.reason === 'one_off_expired'
              ? 'ONE_OFF_YEAR_END_NOT_ACTIVE'
              : sieImportAccess.reason === 'company_not_found'
                ? 'INVALID_COMPANY_ID'
                : sieImportAccess.reason === 'database_error'
                  ? 'DATABASE_QUERY_FAILED'
                  : 'YEAR_END_ENTITLEMENT_REQUIRED'
          return errorResponseFromCode(code, userLog, {
            requestId,
            details: { operation: 'resolve_sie_import_access' },
            reason: sieImportAccess.databaseError,
          })
        }
        if (requireWrite && !sieImportAccess.canWrite) {
          return errorResponseFromCode('PERMISSION_DENIED', userLog, { requestId })
        }
        routeSupabase = serviceDb

        if (sieImportAccess.mode === 'platform') {
          try {
            await auditPlatformSieImportOperation(serviceDb, {
              actorUserId: user.id,
              companyId,
              operation,
              requestId,
            })
          } catch (auditError) {
            return errorResponseFromCode('DATABASE_QUERY_FAILED', userLog, {
              requestId,
              details: { operation: 'audit_platform_sie_import_operation' },
              reason: auditError instanceof Error ? auditError.message : String(auditError),
            })
          }
        }
      } else {
        const requiredFeature = featureForOperation(operation)
        if (requiredFeature) {
          const featureAccess = await checkFeatureAccess(supabase, companyId, requiredFeature)
          if (!featureAccess.allowed) {
            userLog.warn('feature access denied', { feature: requiredFeature, reason: featureAccess.reason })
            const response = featureAccessError(requiredFeature)
            response.headers.set('X-Request-Id', requestId)
            return response
          }
        }
      }

      if (requireWrite) {
        // Read-only maintenance mode: reject every mutating dashboard route
        // with a clear Swedish message. Checked before the membership write
        // check so the operator kill switch works even if the DB is degraded.
        if (maintenanceBlocksWrites()) {
          userLog.warn('write rejected — maintenance read-only mode')
          return errorResponseFromCode('MAINTENANCE_READ_ONLY', userLog, {
            requestId,
            messageSv: getMaintenanceMessage(),
          })
        }

        if (accessPolicy !== 'sie_import') {
          if (requestedCompanyCanWrite === false) {
            return errorResponseFromCode('PERMISSION_DENIED', userLog, { requestId })
          }
          if (requestedCompanyCanWrite === null) {
            // Delegate to the existing helper for the ordinary active-company path.
            const writeCheck = await requireWritePermission(supabase, user.id)
            if (!writeCheck.ok) {
              userLog.warn('write permission denied')
              if (!writeCheck.response.headers.get('X-Request-Id')) {
                writeCheck.response.headers.set('X-Request-Id', requestId)
              }
              return writeCheck.response
            }
          }
        }
      }

      const ctx: RouteContext = {
        requestId,
        log: userLog.child({ companyId }),
        user,
        supabase: routeSupabase,
        companyId,
        ...(sieImportAccess ? { sieImportAccess } : {}),
      }
      errLog = ctx.log

      const response = await handler(request, ctx, params)

      if (response instanceof Response && !response.headers.get('X-Request-Id')) {
        response.headers.set('X-Request-Id', requestId)
      }

      ctx.log.info('op completed', {
        durationMs: Date.now() - start,
        status: response.status,
      })
      return response
    } catch (err) {
      errLog.error('op failed', err as Error, { durationMs: Date.now() - start })
      return errorResponse(err, errLog, { requestId })
    }
  }
}
