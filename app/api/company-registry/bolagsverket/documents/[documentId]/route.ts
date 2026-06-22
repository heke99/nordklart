import { NextResponse, type NextRequest } from 'next/server'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { getAnnualReportZipAtBolagsverket } from '@/lib/company-registry/provider'

function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown'
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params
  const safeDocumentId = documentId?.trim()
  if (!safeDocumentId || safeDocumentId.length > 200) {
    return NextResponse.json({ error: 'Dokument-id saknas eller är ogiltigt.' }, { status: 400 })
  }

  const limit = await checkRateLimit({
    prefix: 'company-registry:bolagsverket:document-download',
    identifier: `${clientIp(request)}:${safeDocumentId}`,
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
