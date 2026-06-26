import { NextResponse } from 'next/server'
import { requirePlatformRole } from '@/lib/auth/platform'
import { getSkvConfigStatus, getSkvSysorgAccessToken } from '@/lib/skatteverket/sysorg'

export const dynamic = 'force-dynamic'

export async function POST() {
  await requirePlatformRole({ roles: ['platform_admin', 'platform_support'] })

  const config = getSkvConfigStatus()
  if (!config.readyForTokenTest) {
    return NextResponse.json(
      {
        error: 'Skatteverket sysorg är inte färdigkonfigurerat.',
        checks: config.checks,
      },
      { status: 400 },
    )
  }

  try {
    const token = await getSkvSysorgAccessToken({ forceRefresh: true })
    return NextResponse.json({
      data: {
        ok: true,
        tokenType: token.tokenType,
        scope: token.scope,
        expiresAt: new Date(token.expiresAt).toISOString(),
        expiresInSeconds: Math.max(0, Math.floor((token.expiresAt - Date.now()) / 1000)),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token-test misslyckades.'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
