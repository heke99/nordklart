import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { startConsentSigning, CONSENT_TYPE_LABELS_SV, type ConsentType } from '@/lib/auth/consent-service'

ensureInitialized()

/**
 * GET  /api/bankid/consents — list the company's signed consents.
 * POST /api/bankid/consents — start a BankID consent-signing session.
 *
 * The provider abstraction resolves to TIC (hosted, production) or the mock
 * provider (self-hosted/test) — see lib/auth/bankid-provider.ts.
 */

const ConsentTypeSchema = z.enum([
  'agency_data_sharing',
  'bank_connection',
  'skatteverket',
  'invoice_financing',
  'api_integration',
  'bankgiro_autogiro',
  'arsredovisning_signature',
  'other',
])

const StartSchema = z.object({
  consent_type: ConsentTypeSchema,
  title: z.string().max(200).optional(),
  consent_text: z.string().min(10, 'Samtyckestexten är för kort').max(10_000),
  context: z.record(z.string(), z.unknown()).optional(),
})

export const GET = withRouteContext(
  'bankid.consents.list',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { data, error } = await supabase
      .from('signed_consents')
      .select('id, consent_type, title, signed_via, personal_number_masked, signer_name, status, revoked_at, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) {
      return errorResponse(error, log, { requestId })
    }
    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'bankid.consents.start',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, StartSchema, {
      log,
      operation: 'bankid.consents.start',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    const endUserIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      '127.0.0.1'

    try {
      const result = await startConsentSigning(supabase, {
        companyId: companyId!,
        userId: user.id,
        consentType: body.consent_type as ConsentType,
        title: body.title ?? CONSENT_TYPE_LABELS_SV[body.consent_type as ConsentType],
        consentText: body.consent_text,
        endUserIp,
        userAgent: request.headers.get('user-agent') ?? undefined,
        context: body.context,
      })
      return NextResponse.json({ data: result })
    } catch (err) {
      log.error('consent signing start failed', err as Error)
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
