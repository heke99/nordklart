import { NextResponse, type NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { checkDurableRateLimit } from '@/lib/auth/rate-limit-durable'
import { getAnnualReportZipAtBolagsverket } from '@/lib/company-registry/provider'

// Signed-in only; see ../route.ts.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const auth = await requireAuth()
  if (auth.error) return auth.error

  const { documentId } = await params
  const safeDocumentId = documentId?.trim()
  if (!safeDocumentId || safeDocumentId.length > 200) {
    return NextResponse.json({ error: 'Dokument-id saknas eller är ogiltigt.' }, { status: 400 })
  }

  const limit = await checkDurableRateLimit({
    prefix: 'company-registry:bolagsverket:document-download',
    identifier: auth.user.id,
    maxRequests: 8,
    windowMs: 15 * 60 * 1000,
  })
  if (!limit.ok) return limit.response!

  const result = await getAnnualReportZipAtBolagsverket(safeDocumentId)
  if (!result.available) return NextResponse.json({ available: false }, { status: 503 })
  if (!result.document) return NextResponse.json({ error: 'Dokumentet kunde inte hittas.' }, { status: 404 })

  return new NextResponse(result.document, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="bolagsverket-${safeDocumentId}.zip"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
