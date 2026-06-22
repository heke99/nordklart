import { NextResponse } from 'next/server'
import { isBolagsverketRegistryAvailable } from '@/lib/company-registry/provider'

export async function GET() {
  const result = await isBolagsverketRegistryAvailable()
  return NextResponse.json(result, { status: result.available ? 200 : 503 })
}
