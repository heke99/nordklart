import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { createNewVersion, validateDocumentFile } from '@/lib/core/documents/document-service'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

ensureInitialized()

/**
 * POST /api/documents/:id/versions
 * Create a new version of an existing document (atomic via RPC)
 *
 * Accepts multipart/form-data with:
 * - file: The new version file
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
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    const validationError = validateDocumentFile({ size: file.size, type: file.type })
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 })
    }

    const buffer = await file.arrayBuffer()

    const newVersion = await createNewVersion(supabase, user.id, id, {
      name: file.name,
      buffer,
      type: file.type,
    })

    return NextResponse.json({ data: newVersion })
  } catch (error) {
    console.error('[documents/versions/POST] Version creation failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Version creation failed' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/documents/:id/versions
 * List all versions in the document chain
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { id } = await params

  // First, check if the document belongs to the company
  const { data: doc, error: docError } = await supabase
    .from('document_attachments')
    .select('id, original_id')
    .eq('id', id)
    .eq('company_id', companyId)
    .single()

  if (docError || !doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  // The root document is either the original_id or the document itself
  const rootId = doc.original_id || doc.id

  // Fetch all versions in the chain
  const { data: versions, error: versionsError } = await supabase
    .from('document_attachments')
    .select('*')
    .eq('company_id', companyId)
    .or(`id.eq.${rootId},original_id.eq.${rootId}`)
    .order('version', { ascending: true })

  if (versionsError) {
    return NextResponse.json({ error: versionsError.message }, { status: 500 })
  }

  return NextResponse.json({ data: versions })
}
