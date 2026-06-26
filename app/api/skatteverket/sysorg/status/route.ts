import { NextResponse } from 'next/server'
import { requirePlatformRole } from '@/lib/auth/platform'
import { getCachedSkvSysorgTokenMeta, getSkvConfigStatus } from '@/lib/skatteverket/sysorg'

export const dynamic = 'force-dynamic'

export async function GET() {
  await requirePlatformRole()
  return NextResponse.json({
    data: {
      ...getSkvConfigStatus(),
      cachedToken: getCachedSkvSysorgTokenMeta(),
    },
  })
}
