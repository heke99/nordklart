import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { verifyIntegrity } from '@/lib/core/documents/document-service'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

ensureInitialized()

/**
 * POST /api/documents/:id/verify
 * Verify document integrity by re-computing SHA-256 and comparing
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { id } = await params

  try {
    const result = await verifyIntegrity(supabase, companyId, id)

    return NextResponse.json({ data: result })
  } catch (error) {
    console.error('[documents/verify/POST] Verification failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Verification failed' },
      { status: 500 }
    )
  }
}
