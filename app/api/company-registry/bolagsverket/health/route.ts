import { NextResponse } from 'next/server'
import { isBolagsverketRegistryAvailable } from '@/lib/company-registry/provider'

export async function GET() {
  const result = await isBolagsverketRegistryAvailable()
  return NextResponse.json({
    available: result.available,
    configured: result.configured,
    environment: result.environment,
    reason: 'reason' in result ? result.reason : undefined,
    status: 'status' in result ? result.status : undefined,
    requestId: 'requestId' in result ? result.requestId : undefined,
  }, {
    status: result.available ? 200 : 503,
    headers: { 'Cache-Control': 'public, max-age=0, must-revalidate' },
  })
}
