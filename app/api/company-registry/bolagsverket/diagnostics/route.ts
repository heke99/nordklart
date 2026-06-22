import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { requireWritePermission } from '@/lib/auth/require-write'
import { diagnoseBolagsverketRegistry } from '@/lib/company-registry/provider'

export async function GET() {
  const { user, supabase, error: authError } = await requireAuth()
  if (authError) return authError

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const diagnostics = await diagnoseBolagsverketRegistry()
  const healthy = Boolean(diagnostics.configured && diagnostics.token?.ok && diagnostics.isAlive?.ok)

  return NextResponse.json(diagnostics, {
    status: healthy ? 200 : 503,
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
